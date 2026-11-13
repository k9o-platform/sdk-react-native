import { GateClient } from "../src/index";
import { __resetStore } from "../__mocks__/react-native-keychain";

// The end-user flow calls: passkeys, authenticator app, password reset, invitation redeem, session check.
// Each is checked for its path, body, bearer header and answer, against a mocked fetch.

const ORG_URL = "https://acme.api.example.test";
const SESSION = { accessToken: "at_One", refreshToken: "rt_Flow0001", expiresAt: "2099-01-01T00:00:00Z" };

class InMemoryTokenStore {
  private token: string | null = null;
  async save(t: string) { this.token = t; }
  async load() { return this.token; }
  async delete() { this.token = null; }
}

type Call = { url: string; method: string; body?: string; headers: Record<string, string> };

function mockFetch(data: unknown, status = 200) {
  global.fetch = jest.fn().mockImplementation(async (_url: string) => {
    const ok = status >= 200 && status < 300;
    const text = ok ? JSON.stringify({ data, meta: {} }) : JSON.stringify({ code: "K9O_INVALID_FIELD_VALUE", message: "no", context: {}, recommendation: null });
    return { ok, status, text: jest.fn().mockResolvedValue(text) };
  });
}

/** The calls that carry the request (the one-time region probe is a HEAD). */
function apiCalls(): Call[] {
  return (fetch as jest.Mock).mock.calls
    .filter((c) => c[1]?.method !== "HEAD")
    .map((c) => ({ url: String(c[0]), method: c[1].method, body: c[1].body, headers: c[1].headers ?? {} }));
}

function makeGate(store: InMemoryTokenStore = new InMemoryTokenStore()) {
  return { gate: new GateClient({ orgBaseUrl: ORG_URL, projectSlug: "shop", tokenStore: store }), store };
}

beforeEach(() => __resetStore());
afterEach(() => { delete (global as Record<string, unknown>).fetch; });

describe("passkeys", () => {
  test("register.begin posts no body and sends the end user's bearer", async () => {
    mockFetch({ challenge: "c1", rp: { id: "example.test" } });
    const { gate } = makeGate();
    const out = await gate.passkeys.register.begin({ bearerToken: "eu_access" });
    expect(out.challenge).toBe("c1");
    const call = apiCalls()[0]!;
    expect(call.url).toBe(`${ORG_URL}/@shop/gate/passkeys/register/begin`);
    expect(call.method).toBe("POST");
    expect(call.body).toBeUndefined();
    expect(call.headers["Authorization"]).toBe("Bearer eu_access");
  });

  test("register.finish sends the credential and label with the bearer", async () => {
    mockFetch({ passkey: { id: "pk_1", credentialId: "cred_1" } });
    const { gate } = makeGate();
    const response = { id: "cred_1", response: { attestationObject: "a" } };
    const out = await gate.passkeys.register.finish({ response, label: "Phone" }, { bearerToken: "eu_access" });
    expect(out.passkey).toEqual({ id: "pk_1", credentialId: "cred_1" });
    const call = apiCalls()[0]!;
    expect(call.url).toBe(`${ORG_URL}/@shop/gate/passkeys/register/finish`);
    expect(JSON.parse(call.body!)).toEqual({ response, label: "Phone" });
    expect(call.headers["Authorization"]).toBe("Bearer eu_access");
  });

  test("signIn.begin sends the email and no bearer; the email is optional", async () => {
    mockFetch({ challenge: "c2" });
    const { gate } = makeGate();
    await gate.passkeys.signIn.begin({ email: "a@example.test" });
    await gate.passkeys.signIn.begin();
    const [first, second] = apiCalls();
    expect(first!.url).toBe(`${ORG_URL}/@shop/gate/passkeys/signin/begin`);
    expect(JSON.parse(first!.body!)).toEqual({ email: "a@example.test" });
    expect(JSON.parse(second!.body!)).toEqual({});
    expect(first!.headers["Authorization"]).toBeUndefined();
  });

  test("signIn.finish returns the session and persists its refresh token", async () => {
    mockFetch({ session: SESSION });
    const { gate, store } = makeGate();
    const response = { id: "cred_1", response: { signature: "s" } };
    const out = await gate.passkeys.signIn.finish({ response });
    expect(out.session).toEqual(SESSION);
    expect(await store.load()).toBe("rt_Flow0001");
    const call = apiCalls()[0]!;
    expect(call.url).toBe(`${ORG_URL}/@shop/gate/passkeys/signin/finish`);
    expect(JSON.parse(call.body!)).toEqual({ response });
    expect(call.headers["Authorization"]).toBeUndefined();
  });

  test("a refused challenge is a GateError and stores nothing", async () => {
    mockFetch({}, 400);
    const { gate, store } = makeGate();
    await expect(gate.passkeys.signIn.finish({ response: { id: "x", response: {} } })).rejects.toMatchObject({
      code: "K9O_INVALID_FIELD_VALUE",
      statusCode: 400,
    });
    expect(await store.load()).toBeNull();
  });
});

describe("second factors (mfa.methods)", () => {
  test("list sends a GET with the bearer and no body", async () => {
    const methods = [{ id: "mf_1", type: "totp", label: "Phone", verifiedAt: "2026-11-13T00:00:00Z", createdAt: "2026-11-12T00:00:00Z" }];
    mockFetch({ methods });
    const { gate } = makeGate();
    const out = await gate.mfa.methods.list({ bearerToken: "eu_access" });
    expect(out.methods).toEqual(methods);
    const call = apiCalls()[0]!;
    expect(call.method).toBe("GET");
    expect(call.url).toBe(`${ORG_URL}/@shop/gate/mfa/methods`);
    expect(call.body).toBeUndefined();
    expect(call.headers["Authorization"]).toBe("Bearer eu_access");
  });

  test("delete sends DELETE with the code as the body", async () => {
    mockFetch({ deleted: true });
    const { gate } = makeGate();
    const out = await gate.mfa.methods.delete("mf_1", { bearerToken: "eu_access", code: "123456" });
    expect(out).toEqual({ deleted: true });
    const call = apiCalls()[0]!;
    expect(call.method).toBe("DELETE");
    expect(call.url).toBe(`${ORG_URL}/@shop/gate/mfa/methods/mf_1`);
    expect(JSON.parse(call.body!)).toEqual({ code: "123456" });
    expect(call.headers["Authorization"]).toBe("Bearer eu_access");
  });

  test("delete without a code sends no body and encodes the id", async () => {
    mockFetch({ deleted: false });
    const { gate } = makeGate();
    const out = await gate.mfa.methods.delete("a/b", { bearerToken: "eu_access" });
    expect(out.deleted).toBe(false);
    const call = apiCalls()[0]!;
    expect(call.url).toBe(`${ORG_URL}/@shop/gate/mfa/methods/a%2Fb`);
    expect(call.body).toBeUndefined();
  });

  test("delete raises the gateway's error", async () => {
    mockFetch({}, 403);
    const { gate } = makeGate();
    await expect(gate.mfa.methods.delete("mf_1", { bearerToken: "eu_access" })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("authenticator app (totp)", () => {
  test("enroll sends the label with the bearer and returns the factor", async () => {
    mockFetch({ factor: { id: "mf_1", secret: "JBSWY3DP", uri: "otpauth://totp/x" } });
    const { gate, store } = makeGate();
    const out = await gate.mfa.totp.enroll({ label: "Work phone" }, { bearerToken: "eu_access" });
    expect(out.factor.id).toBe("mf_1");
    const call = apiCalls()[0]!;
    expect(call.url).toBe(`${ORG_URL}/@shop/gate/mfa/totp/enroll`);
    expect(JSON.parse(call.body!)).toEqual({ label: "Work phone" });
    expect(call.headers["Authorization"]).toBe("Bearer eu_access");
    expect(await store.load()).toBeNull();
  });

  test("confirm sends the code and currentCode; a first factor's new session is persisted", async () => {
    mockFetch({ factor: { id: "mf_1", verifiedAt: "2026-11-13T00:00:00Z" }, session: SESSION });
    const { gate, store } = makeGate();
    const out = await gate.mfa.totp.confirm({ factorId: "mf_1", code: "123456", currentCode: "654321" }, { bearerToken: "eu_access" });
    expect(out.session).toEqual(SESSION);
    expect(await store.load()).toBe("rt_Flow0001");
    const call = apiCalls()[0]!;
    expect(call.url).toBe(`${ORG_URL}/@shop/gate/mfa/totp/confirm`);
    expect(JSON.parse(call.body!)).toEqual({ factorId: "mf_1", code: "123456", currentCode: "654321" });
    expect(call.headers["Authorization"]).toBe("Bearer eu_access");
  });

  test("confirm without a session in the answer leaves the stored token alone", async () => {
    mockFetch({ factor: { id: "mf_2", verifiedAt: "2026-11-13T00:00:00Z" } });
    const { gate, store } = makeGate();
    await store.save("rt_Existing");
    await gate.mfa.totp.confirm({ factorId: "mf_2", code: "111111", currentCode: "222222" }, { bearerToken: "eu_access" });
    expect(await store.load()).toBe("rt_Existing");
  });
});

describe("password reset", () => {
  test("request asks the locate door for the email's region, then posts the email with no bearer", async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      const door = String(url).endsWith("/gate/locate");
      const body = door ? { region: "de01", origin: null } : { reset: { requested: true, expiresAt: "2026-11-13T01:00:00Z" } };
      return { ok: true, status: 200, text: jest.fn().mockResolvedValue(JSON.stringify({ data: body, meta: {} })) };
    });
    const { gate } = makeGate();
    const out = await gate.passwordReset.request({ email: "a@example.test" });
    expect(out.reset.requested).toBe(true);
    const urls = apiCalls().map((c) => c.url);
    expect(urls).toContain(`${ORG_URL}/@shop/gate/locate`);
    const call = apiCalls().find((c) => c.url.endsWith("/password-reset/request"))!;
    expect(JSON.parse(call.body!)).toEqual({ email: "a@example.test" });
    expect(call.headers["Authorization"]).toBeUndefined();
  });

  test("redeem with a session persists its refresh token", async () => {
    mockFetch({ redeemed: true, endUserId: "eu_1", session: SESSION });
    const { gate, store } = makeGate();
    const out = await gate.passwordReset.redeem({ token: "tok", newPassword: "a long new password" });
    expect(out.endUserId).toBe("eu_1");
    expect(await store.load()).toBe("rt_Flow0001");
    const call = apiCalls()[0]!;
    expect(call.url).toBe(`${ORG_URL}/@shop/gate/password-reset/redeem`);
    expect(JSON.parse(call.body!)).toEqual({ token: "tok", newPassword: "a long new password" });
  });

  test("redeem that answers an mfa challenge returns it and stores nothing", async () => {
    const mfa = { required: true, challengeId: "ch_1", expiresAt: "2026-11-13T00:05:00Z", methodsAvailable: ["totp"], resident: { region: "de01", origin: ORG_URL } };
    mockFetch({ redeemed: true, endUserId: "eu_1", mfa });
    const { gate, store } = makeGate();
    const out = await gate.passwordReset.redeem({ token: "tok", newPassword: "a long new password" });
    expect(out.mfa).toEqual(mfa);
    expect(out.session).toBeUndefined();
    expect(await store.load()).toBeNull();
  });
});

describe("invitations", () => {
  test("redeem creates the user, returns the session and persists its refresh token", async () => {
    mockFetch({ redeemed: true, user: { id: "eu_9", email: "new@example.test" }, session: SESSION });
    const { gate, store } = makeGate();
    const out = await gate.invitations.redeem({ token: "inv", password: "a long password", displayName: "New" });
    expect(out.user).toEqual({ id: "eu_9", email: "new@example.test" });
    expect(await store.load()).toBe("rt_Flow0001");
    const call = apiCalls()[0]!;
    expect(call.url).toBe(`${ORG_URL}/@shop/gate/invitations/redeem`);
    expect(JSON.parse(call.body!)).toEqual({ token: "inv", password: "a long password", displayName: "New" });
    expect(call.headers["Authorization"]).toBeUndefined();
  });
});

describe("verifySession", () => {
  test("sends the token in the body and the caller's bearer, and returns the claims", async () => {
    const claims = { subjectId: "eu_1", projectId: "proj_1", expiresAt: "2099-01-01T00:00:00Z" };
    mockFetch({ valid: true, claims });
    const { gate } = makeGate();
    const out = await gate.verifySession({ token: "eu_access" }, { bearerToken: "backend_token" });
    expect(out).toEqual({ valid: true, claims });
    const call = apiCalls()[0]!;
    expect(call.url).toBe(`${ORG_URL}/@shop/gate/verify-session`);
    expect(JSON.parse(call.body!)).toEqual({ token: "eu_access" });
    expect(call.headers["Authorization"]).toBe("Bearer backend_token");
  });

  test("a refused token is an answer with valid false, not an error", async () => {
    mockFetch({ valid: false, reason: "expired" });
    const { gate } = makeGate();
    expect(await gate.verifySession({ token: "old" }, { bearerToken: "backend_token" })).toEqual({ valid: false, reason: "expired" });
  });
});
