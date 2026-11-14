import { GateClient, GateError, KeychainTokenStore, AccessToken } from "../src/index";
import { __resetStore } from "../__mocks__/react-native-keychain";

// MARK: - Helpers

const ORG_URL = "https://acme.api.k9o.io";
const AUTH_RESULT = {
  user: {
    id: "eu_TestUserABC123",
    email: "user@example.com",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: null,
    lastSigninAt: null,
    roles: ["PROJECT_END_USER"],
    groups: [],
  },
  session: {
    accessToken:
      "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJldV9UZXN0VXNlckFCQzEyMyIsImV4cCI6OTk5OTk5OTk5OSwiaWF0IjoxNzAwMDAwMDAwLCJpc3MiOiJodHRwczovL2FwaS5rOW8uaW8iLCJleHQucGFydG5lcnMiOnsicGFydG5lcl9yb2xlIjoiZXh0ZW5zaW9uX29yZ19hZG1pbiJ9fQ.sig",
    refreshToken: "rt_MockRefreshToken0001",
    expiresAt: "2099-01-01T00:00:00Z",
  },
};

function authBody() {
  return JSON.stringify({ data: AUTH_RESULT, meta: {} });
}

// Matches the real gateway error body: a KError at the ROOT,
// platform-namespaced `K9O_*` codes — NOT a `{ error: { … } }` wrapper.
function errorBody(code: string) {
  return JSON.stringify({ code, message: "Error", context: {}, recommendation: null });
}

class InMemoryTokenStore {
  private token: string | null = null;
  async save(t: string) { this.token = t; }
  async load() { return this.token; }
  async delete() { this.token = null; }
}

// Sign-in asks the locate door first; these tests are about the call after it (locate.test.ts covers the door).
const LOCATE_ANSWER = JSON.stringify({ data: { region: "de01", origin: null }, meta: {} });

function mockFetch(body: string, status = 200) {
  global.fetch = jest.fn().mockImplementation(async (url: string) => {
    const door = String(url).endsWith("/gate/locate");
    const text = door ? LOCATE_ANSWER : body;
    return { ok: door || (status >= 200 && status < 300), status: door ? 200 : status, text: jest.fn().mockResolvedValue(text) };
  });
}

/** The calls that carry the request (the one-time region probe is a HEAD; the locate door is not the credential call). */
function apiCalls(): [string, { method: string; body?: string; headers: Record<string, string> }][] {
  return (fetch as jest.Mock).mock.calls.filter((c) => c[1]?.method !== "HEAD" && !String(c[0]).endsWith("/gate/locate"));
}

function jwtWith(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "ES256", typ: "JWT" })}.${b64(claims)}.sig`;
}

function makeGate(store?: InMemoryTokenStore) {
  return new GateClient({
    orgBaseUrl: ORG_URL,
    projectSlug: "test-project",
    tokenStore: store ?? new InMemoryTokenStore(),
  });
}

beforeEach(() => __resetStore());
afterEach(() => { delete (global as Record<string, unknown>).fetch; });

// MARK: - signIn happy path

test("signIn happy path returns user and session", async () => {
  mockFetch(authBody());
  const gate = makeGate();
  const result = await gate.signIn({ email: "user@example.com", password: "pass" });
  expect(result.user.id).toBe("eu_TestUserABC123");
  expect(result.user.email).toBe("user@example.com");
  expect(result.session.refreshToken).toBe("rt_MockRefreshToken0001");
});

test("signIn persists refresh token to store", async () => {
  mockFetch(authBody());
  const store = new InMemoryTokenStore();
  const gate = makeGate(store);
  await gate.signIn({ email: "user@example.com", password: "pass" });
  expect(await store.load()).toBe("rt_MockRefreshToken0001");
});

test("signIn sends correct URL path suffix", async () => {
  mockFetch(authBody());
  const gate = makeGate();
  await gate.signIn({ email: "u@e.com", password: "p" });
  const url = apiCalls()[0]![0];
  expect(url).toContain("/@test-project/gate/signin");
});

// MARK: - refreshToken happy path

const REFRESH_RESULT = { accessToken: "access-new", refreshToken: "rt_NextToken0002", expiresAt: "2099-01-02T00:00:00Z" };

test("refreshToken reads the stored token, returns the new access token and stores the next refresh token", async () => {
  const store = new InMemoryTokenStore();
  await store.save("rt_InitialToken");
  mockFetch(JSON.stringify({ data: REFRESH_RESULT, meta: {} }));
  const gate = makeGate(store);
  const result = await gate.refreshToken();
  expect(result).toEqual(REFRESH_RESULT);
  expect(await store.load()).toBe("rt_NextToken0002");
  const [url, init] = apiCalls()[0]!;
  expect(url).toContain("/@test-project/gate/refresh");
  expect(JSON.parse(init.body as string)).toEqual({ refreshToken: "rt_InitialToken" });
});

test("refreshToken explicit token overrides store", async () => {
  const store = new InMemoryTokenStore();
  await store.save("rt_ShouldNotBeUsed");
  mockFetch(JSON.stringify({ data: REFRESH_RESULT, meta: {} }));
  const gate = makeGate(store);
  await gate.refreshToken({ refreshToken: "rt_Explicit" });
  const body = JSON.parse(apiCalls()[0]![1].body as string) as Record<string, unknown>;
  expect(body).toEqual({ refreshToken: "rt_Explicit" });
});

test("refreshToken with a token that is not the stored one leaves the store alone", async () => {
  const store = new InMemoryTokenStore();
  await store.save("rt_Stored");
  mockFetch(JSON.stringify({ data: REFRESH_RESULT, meta: {} }));
  await makeGate(store).refreshToken({ refreshToken: "rt_Other" });
  expect(await store.load()).toBe("rt_Stored");
});

test("concurrent refreshes share one request and never send the same token twice", async () => {
  const store = new InMemoryTokenStore();
  await store.save("rt_Initial");
  let release!: () => void;
  const gateOpen = new Promise<void>((r) => (release = r));
  global.fetch = jest.fn().mockImplementation(async () => {
    await gateOpen;
    return { ok: true, status: 200, text: jest.fn().mockResolvedValue(JSON.stringify({ data: REFRESH_RESULT, meta: {} })) };
  });
  const gate = makeGate(store);
  const calls = [gate.refreshToken(), gate.refreshToken(), gate.refreshToken()];
  release();
  const results = await Promise.all(calls);
  expect(results.every((r) => r.refreshToken === "rt_NextToken0002")).toBe(true);
  expect(apiCalls()).toHaveLength(1);
  // The next refresh starts from the stored next token.
  await gate.refreshToken();
  expect(JSON.parse(apiCalls()[1]![1].body as string)).toEqual({ refreshToken: "rt_NextToken0002" });
});

test("signOut waits for a refresh in flight and signs out the new token", async () => {
  const store = new InMemoryTokenStore();
  await store.save("rt_Initial");
  let release!: () => void;
  const gateOpen = new Promise<void>((r) => (release = r));
  global.fetch = jest.fn().mockImplementation(async (url: string) => {
    if (String(url).endsWith("/refresh")) await gateOpen;
    const data = String(url).endsWith("/refresh") ? REFRESH_RESULT : { revoked: true };
    return { ok: true, status: 200, text: jest.fn().mockResolvedValue(JSON.stringify({ data, meta: {} })) };
  });
  const gate = makeGate(store);
  const refreshing = gate.refreshToken();
  const signingOut = gate.signOut();
  release();
  await Promise.all([refreshing, signingOut]);
  const bodies = apiCalls().map((c) => JSON.parse(c[1].body as string));
  expect(bodies).toEqual([{ refreshToken: "rt_Initial" }, { refreshToken: "rt_NextToken0002" }]);
  expect(await store.load()).toBeNull();
});

describe.each(["replay", "revoked", "inactive", "max_length"])("session ended: %s", (reason) => {
  test("refreshToken clears the store and exposes the reason", async () => {
    const store = new InMemoryTokenStore();
    await store.save("rt_Old");
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: jest.fn().mockResolvedValue(JSON.stringify({ code: "K9O_SESSION_EXPIRED", message: "x", context: { reason }, recommendation: null })),
    });
    await expect(makeGate(store).refreshToken()).rejects.toMatchObject({ code: "UNAUTHENTICATED", statusCode: 401, sessionEndReason: reason });
    expect(await store.load()).toBeNull();
  });
});

test("an unknown refresh token (INVALID_CREDENTIALS) clears the store", async () => {
  const store = new InMemoryTokenStore();
  await store.save("rt_Unknown");
  mockFetch(errorBody("K9O_INVALID_CREDENTIALS"), 401);
  await expect(makeGate(store).refreshToken()).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  expect(await store.load()).toBeNull();
});

test("a network failure keeps the stored token", async () => {
  const store = new InMemoryTokenStore();
  await store.save("rt_Keep");
  global.fetch = jest.fn().mockRejectedValue(new Error("offline"));
  await expect(makeGate(store).refreshToken()).rejects.toMatchObject({ code: "NETWORK" });
  expect(await store.load()).toBe("rt_Keep");
});

test("sessionEndReason is kept when errors are redacted, and null for other 401s", async () => {
  const store = new InMemoryTokenStore();
  await store.save("rt_Old");
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 401,
    text: jest.fn().mockResolvedValue(JSON.stringify({ code: "K9O_SESSION_EXPIRED", message: "x", context: { reason: "replay" }, recommendation: null })),
  });
  const gate = new GateClient({ orgBaseUrl: ORG_URL, projectSlug: "test-project", tokenStore: store, errors: "redacted" });
  await expect(gate.refreshToken()).rejects.toMatchObject({ sessionEndReason: "replay" });
  expect(GateError.unauthenticated().sessionEndReason).toBeNull();
});

// MARK: - signOut

test("signOut clears token store", async () => {
  const store = new InMemoryTokenStore();
  await store.save("rt_ToRevoke");
  mockFetch(JSON.stringify({ data: { revoked: true }, meta: {} }));
  const gate = makeGate(store);
  await gate.signOut();
  expect(await store.load()).toBeNull();
  const [url, init] = apiCalls()[0]!;
  expect(url).toContain("/@test-project/gate/signout");
  expect(JSON.parse(init.body as string)).toEqual({ refreshToken: "rt_ToRevoke" });
});

test("signOut is no-op when no token", async () => {
  global.fetch = jest.fn();
  const gate = makeGate();
  await gate.signOut();
  expect(fetch).not.toHaveBeenCalled();
});

// MARK: - revokeAllSessions

test("revokeAllSessions posts with the access token, resolves to the count and clears the store", async () => {
  const store = new InMemoryTokenStore();
  await store.save("rt_ToRevoke");
  mockFetch(JSON.stringify({ data: { revokedCount: 3 }, meta: {} }));
  const gate = makeGate(store);
  await expect(gate.revokeAllSessions({ accessToken: "access.jwt.value" })).resolves.toBe(3);
  const [url, init] = apiCalls()[0]!;
  expect(url).toBe("https://acme.api.k9o.io/@test-project/auth/sessions/revoke-all");
  expect(init.method).toBe("POST");
  expect(init.headers["Authorization"]).toBe("Bearer access.jwt.value");
  expect(init.body).toBeUndefined();
  expect(await store.load()).toBeNull();
});

test.each(["K9O_TRUST_ZONE_VIOLATION", "K9O_PROJECT_SCOPE_MISMATCH"])(
  "revokeAllSessions refused with %s is a GateError and keeps the store",
  async (code) => {
    const store = new InMemoryTokenStore();
    await store.save("rt_Keep");
    mockFetch(errorBody(code), 403);
    const gate = makeGate(store);
    await expect(gate.revokeAllSessions({ accessToken: "operator.token" })).rejects.toMatchObject({ code, statusCode: 403 });
    expect(await store.load()).toBe("rt_Keep");
  },
);

// MARK: - Error cases

test("signIn throws GateError INVALID_CREDENTIALS on 401", async () => {
  mockFetch(errorBody("K9O_INVALID_CREDENTIALS"), 401);
  const gate = makeGate();
  await expect(gate.signIn({ email: "bad@e.com", password: "wrong" })).rejects.toMatchObject({
    code: "INVALID_CREDENTIALS",
  });
});

test("refreshToken throws GateError UNAUTHENTICATED when no token", async () => {
  const gate = makeGate();
  await expect(gate.refreshToken()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
});

test("non-JSON 200 body throws GateError DECODING", async () => {
  mockFetch("not-json", 200);
  const gate = makeGate();
  await expect(gate.signIn({ email: "u@e.com", password: "p" })).rejects.toMatchObject({
    code: "DECODING",
  });
});

test("500 error with an untyped K9O code keeps the wire code", async () => {
  mockFetch(errorBody("K9O_INTERNAL_ERROR"), 500);
  const gate = makeGate();
  await expect(gate.signIn({ email: "u@e.com", password: "p" })).rejects.toMatchObject({
    code: "K9O_INTERNAL_ERROR",
    statusCode: 500,
  });
});

test("500 error with a non-K9O body maps to GateError UNKNOWN", async () => {
  mockFetch("<html>bad gateway</html>", 500);
  const gate = makeGate();
  await expect(gate.signIn({ email: "u@e.com", password: "p" })).rejects.toMatchObject({
    code: "UNKNOWN",
    statusCode: 500,
  });
});

// MARK: - AccessToken JWT decode

test("AccessToken.decode extracts subject and groups the token's FLAT ext.<ns>.<name> claims", () => {
  const token = AccessToken.decode(
    jwtWith({
      sub: "eu_TestUserABC123",
      exp: 9999999999,
      "ext.partners.partner_role": "extension_org_admin",
      "ext.partners.tier": 3,
      "ext.billing.plan": "pro",
      "ext.malformed": "ignored",
      email: "u@e.com",
    }),
  );
  expect(token).not.toBeNull();
  expect(token!.subject).toBe("eu_TestUserABC123");
  expect(token!.customClaims).toEqual({
    partners: { partner_role: "extension_org_admin", tier: 3 },
    billing: { plan: "pro" },
  });
});

test("AccessToken.decode returns null for malformed JWT", () => {
  expect(AccessToken.decode("not.a.jwt.at.all.whatsoever")).toBeNull();
  expect(AccessToken.decode("only.two")).toBeNull();
  expect(AccessToken.decode("")).toBeNull();
});

// MARK: - KeychainTokenStore (via mock)

test("KeychainTokenStore save/load/delete roundtrip", async () => {
  const store = new KeychainTokenStore();
  expect(await store.load()).toBeNull();
  await store.save("rt_RoundTrip");
  expect(await store.load()).toBe("rt_RoundTrip");
  await store.delete();
  expect(await store.load()).toBeNull();
});

// MARK: - Regional host

test("a region-free org host on an unrelated apex is resolved to its regional host before credentials go out", async () => {
  global.fetch = jest.fn().mockImplementation(async (_url: string, init: { method: string }) =>
    init.method === "HEAD"
      ? { ok: false, status: 308, url: "https://acme.api.corp.internal/", headers: { get: () => "https://acme.api-de01.corp.internal/" } }
      : { ok: true, status: 200, text: async () => (String(_url).endsWith("/gate/locate") ? LOCATE_ANSWER : authBody()) },
  );
  const gate = new GateClient({ orgBaseUrl: "https://acme.api.corp.internal", projectSlug: "p", tokenStore: new InMemoryTokenStore() });
  await gate.signIn({ email: "u@e.com", password: "p" });
  await gate.signIn({ email: "u@e.com", password: "p" });
  const calls = (fetch as jest.Mock).mock.calls;
  expect(calls.filter((c) => c[1].method === "HEAD")).toHaveLength(1);
  expect(calls.filter((c) => c[1].method === "HEAD")[0][1].headers.Authorization).toBeUndefined();
  expect(apiCalls().map((c) => c[0])).toEqual([
    "https://acme.api-de01.corp.internal/@p/gate/signin",
    "https://acme.api-de01.corp.internal/@p/gate/signin",
  ]);
});

test("the regional host is also learned from the final response URL when the runtime followed the redirect", async () => {
  global.fetch = jest.fn().mockImplementation(async (_url: string, init: { method: string }) =>
    init.method === "HEAD"
      ? { ok: true, status: 200, url: "https://acme.api-de01.corp.internal/", headers: { get: () => null } }
      : { ok: true, status: 200, text: async () => (String(_url).endsWith("/gate/locate") ? LOCATE_ANSWER : authBody()) },
  );
  const gate = new GateClient({ orgBaseUrl: "https://acme.api.corp.internal", projectSlug: "p", tokenStore: new InMemoryTokenStore() });
  await gate.signIn({ email: "u@e.com", password: "p" });
  expect(apiCalls()[0]![0]).toBe("https://acme.api-de01.corp.internal/@p/gate/signin");
});

test("a redirect to another org, another apex, or a port is ignored", async () => {
  for (const target of ["https://other.api-de01.corp.internal/", "https://acme.api-de01.evil.example/", "https://acme.api-de01.corp.internal:8443/", "http://acme.api-de01.corp.internal/"]) {
    global.fetch = jest.fn().mockImplementation(async (_url: string, init: { method: string }) =>
      init.method === "HEAD"
        ? { ok: false, status: 308, url: "", headers: { get: () => target } }
        : { ok: true, status: 200, text: async () => (String(_url).endsWith("/gate/locate") ? LOCATE_ANSWER : authBody()) },
    );
    const gate = new GateClient({ orgBaseUrl: "https://acme.api.corp.internal", projectSlug: "p", tokenStore: new InMemoryTokenStore() });
    await gate.signIn({ email: "u@e.com", password: "p" });
    expect(apiCalls()[0]![0]).toBe("https://acme.api.corp.internal/@p/gate/signin");
  }
});

test("localhost and an already-regional host are used as given, with no probe", async () => {
  for (const base of ["http://localhost:8080", "https://acme.api-de01.corp.internal"]) {
    mockFetch(authBody());
    const gate = new GateClient({ orgBaseUrl: base, projectSlug: "p", tokenStore: new InMemoryTokenStore() });
    await gate.signIn({ email: "u@e.com", password: "p" });
    expect((fetch as jest.Mock).mock.calls.filter((c) => c[1].method === "HEAD")).toHaveLength(0);
    expect(apiCalls()).toHaveLength(1);
    expect(apiCalls()[0]![0]).toBe(`${base}/@p/gate/signin`);
  }
});

test("a failed probe falls back to the configured host and is retried next call", async () => {
  let probes = 0;
  global.fetch = jest.fn().mockImplementation(async (_url: string, init: { method: string }) => {
    if (init.method === "HEAD") {
      probes++;
      throw new Error("offline");
    }
    return { ok: true, status: 200, text: async () => (String(_url).endsWith("/gate/locate") ? LOCATE_ANSWER : authBody()) };
  });
  const gate = new GateClient({ orgBaseUrl: "https://acme.api.corp.internal", projectSlug: "p", tokenStore: new InMemoryTokenStore() });
  await gate.signIn({ email: "u@e.com", password: "p" });
  await gate.signIn({ email: "u@e.com", password: "p" });
  expect(probes).toBe(2);
  expect(apiCalls()[0]![0]).toBe("https://acme.api.corp.internal/@p/gate/signin");
});
