import { ErrorsMode, GateClient, GateError } from "../src/index";
import { gateErrorFromResponse } from "../src/GateError";

// Error shaping: unknown codes, requestId, publicMessage, retry-after and the `errors` option.
// localhost is used as the base so no regional probe runs; the locate door answers 200 with no origin.

const BASE = "http://localhost:8080";
const LOCATE_ANSWER = JSON.stringify({ data: { region: "de01", origin: null }, meta: {} });
const MAGIC_LINK_503 = JSON.stringify({
  code: "K9O_MAGIC_LINK_REDIRECT_NOT_CONFIGURED",
  message: "x",
  recommendation: { action: "Register a default redirect" },
});

class InMemoryTokenStore {
  private token: string | null = null;
  async save(t: string) { this.token = t; }
  async load() { return this.token; }
  async delete() { this.token = null; }
}

/** Headers the way a fetch Response exposes them: `get` is case-insensitive. */
function headers(map: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

/** The locate door answers 200; the credential call answers `status`, `body` and `resHeaders`. */
function gateway(status: number, body: string, resHeaders: Record<string, string> = {}) {
  global.fetch = jest.fn().mockImplementation(async (url: string) => {
    if (String(url).endsWith("/gate/locate")) {
      return { ok: true, status: 200, headers: headers({}), text: async () => LOCATE_ANSWER };
    }
    return { ok: status >= 200 && status < 300, status, headers: headers(resHeaders), text: async () => body };
  });
}

/** `errors` is untyped here so the refused-value test can pass a bad one. */
function gate(errors?: unknown) {
  return new GateClient({
    orgBaseUrl: BASE,
    projectSlug: "p",
    tokenStore: new InMemoryTokenStore(),
    ...(errors === undefined ? {} : { errors: errors as ErrorsMode }),
  });
}

async function signInError(g: GateClient): Promise<GateError> {
  try {
    await g.signIn({ email: "u@e.com", password: "p" });
  } catch (e) {
    return e as GateError;
  }
  throw new Error("expected signIn to reject");
}

afterEach(() => { delete (global as Record<string, unknown>).fetch; });

// (a) default mode keeps an unknown K9O code and reads the recommendation and request id

test("(a) 503 with an unknown K9O code keeps the code, recommendation and requestId in full mode", async () => {
  gateway(503, MAGIC_LINK_503, { "x-k9o-request-id": "req_abc" });
  const e = await signInError(gate());
  expect(e).toBeInstanceOf(GateError);
  expect(e.code).toBe("K9O_MAGIC_LINK_REDIRECT_NOT_CONFIGURED");
  expect(e.statusCode).toBe(503);
  expect(e.recommendation).toBe("Register a default redirect");
  expect(e.requestId).toBe("req_abc");
  expect(e.publicMessage).toBe("Something went wrong. Try again later.");
  expect(e.message).toBe(`Unexpected error (HTTP 503): ${MAGIC_LINK_503}`);
  expect(e.body).toBe(MAGIC_LINK_503);
});

// (b) redacted mode reduces the unknown code and drops the gateway's text

test("(b) the same 503 in redacted mode gives UNKNOWN, publicMessage as message, and drops recommendation, context and body", async () => {
  gateway(503, MAGIC_LINK_503, { "x-k9o-request-id": "req_abc" });
  const e = await signInError(gate("redacted"));
  expect(e.code).toBe("UNKNOWN");
  expect(e.message).toBe("Something went wrong. Try again later.");
  expect(e.message).toBe(e.publicMessage);
  expect(e.recommendation).toBeNull();
  expect(e.context).toEqual({});
  expect(e.body).toBeUndefined();
  expect(e.statusCode).toBe(503);
  expect(e.requestId).toBe("req_abc");
});

// (c) a known code keeps its name in both modes

test("(c) a known INVALID_CREDENTIALS 401 keeps its code in both modes", async () => {
  const body = JSON.stringify({ code: "K9O_INVALID_CREDENTIALS", message: "Wrong password", context: { attempts: 2 }, recommendation: null });
  gateway(401, body, { "x-k9o-request-id": "req_known" });

  const full = await signInError(gate());
  expect(full.code).toBe("INVALID_CREDENTIALS");
  expect(full.message).toBe("Invalid credentials.");
  expect(full.context).toEqual({ attempts: 2 });
  expect(full.publicMessage).toBe("You are not signed in or not allowed to do this.");
  expect(full.requestId).toBe("req_known");

  const redacted = await signInError(gate("redacted"));
  expect(redacted.code).toBe("INVALID_CREDENTIALS");
  expect(redacted.message).toBe("You are not signed in or not allowed to do this.");
  expect(redacted.context).toEqual({});
  expect(redacted.statusCode).toBe(401);
  expect(redacted.requestId).toBe("req_known");
});

// (d) a 429 keeps its wait in redacted mode, read from the Retry-After header

test("(d) 429 with Retry-After keeps retryAfterSec and the code in redacted mode", async () => {
  const body = JSON.stringify({ code: "K9O_RATE_LIMITED", message: "cap", context: { reason: "rotation_rate_cap" }, recommendation: null });
  gateway(429, body, { "retry-after": "30" });
  const e = await signInError(gate("redacted"));
  expect(e.code).toBe("RATE_LIMITED");
  expect(e.statusCode).toBe(429);
  expect(e.retryAfterSec).toBe(30);
  expect(e.publicMessage).toBe("Too many attempts. Try again later.");
  expect(e.message).toBe("Too many attempts. Try again later.");
  expect(e.context).toEqual({});
  expect(e.body).toBeUndefined();
});

test("a wait in the body wins over the Retry-After header", async () => {
  const body = JSON.stringify({ code: "K9O_RATE_LIMITED", message: "cap", recommendation: { retryAfterSec: 60, note: "later" } });
  gateway(429, body, { "retry-after": "5400" });
  const e = await signInError(gate());
  expect(e.retryAfterSec).toBe(60);
  expect(e.recommendation).toBe("later");
});

test("an HTTP-date Retry-After gives no wait", async () => {
  gateway(429, JSON.stringify({ code: "K9O_RATE_LIMITED", message: "cap" }), { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" });
  const e = await signInError(gate());
  expect(e.retryAfterSec).toBeNull();
});

// (e) the errors option is validated

test("(e) an invalid errors value is refused at construction", () => {
  let caught: GateError | undefined;
  try {
    gate("loud");
  } catch (e) {
    caught = e as GateError;
  }
  expect(caught).toBeInstanceOf(GateError);
  expect(caught!.code).toBe("K9O_INVALID_FIELD_VALUE");
  expect(caught!.context).toEqual({ field: "errors", value: "loud" });
  expect(caught!.publicMessage).toBe("The request could not be completed.");
});

// publicMessage and requestId edges

test("publicMessage follows the status class", () => {
  const cases: [number, string][] = [
    [401, "You are not signed in or not allowed to do this."],
    [403, "You are not signed in or not allowed to do this."],
    [404, "Not found."],
    [429, "Too many attempts. Try again later."],
    [500, "Something went wrong. Try again later."],
    [599, "Something went wrong. Try again later."],
    [418, "The request could not be completed."],
  ];
  for (const [status, text] of cases) {
    expect(gateErrorFromResponse(status, "not json").publicMessage).toBe(text);
  }
});

test("a network failure has the network publicMessage and no requestId", async () => {
  global.fetch = jest.fn().mockImplementation(async (url: string) => {
    if (String(url).endsWith("/gate/locate")) throw new TypeError("offline");
    throw new TypeError("offline");
  });
  const e = await signInError(gate());
  expect(e.code).toBe("NETWORK");
  expect(e.publicMessage).toBe("Could not reach the service.");
  expect(e.requestId).toBeNull();
  const r = await signInError(gate("redacted"));
  expect(r.message).toBe("Could not reach the service.");
});

test("requestId is null when the response has no request-id header", async () => {
  gateway(503, MAGIC_LINK_503);
  const e = await signInError(gate());
  expect(e.requestId).toBeNull();
});

test("a 2xx body that does not decode keeps requestId and gets the generic publicMessage", async () => {
  gateway(200, "not-json", { "x-k9o-request-id": "req_ok" });
  const e = await signInError(gate());
  expect(e.code).toBe("DECODING");
  expect(e.requestId).toBe("req_ok");
  expect(e.publicMessage).toBe("The request could not be completed.");
});

test("errors defaults to full: an omitted option keeps the wire code", async () => {
  gateway(503, MAGIC_LINK_503);
  const e = await signInError(gate());
  expect(e.code).toBe("K9O_MAGIC_LINK_REDIRECT_NOT_CONFIGURED");
});
