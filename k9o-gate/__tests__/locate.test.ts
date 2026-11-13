/**
 * The locate door: password sign-in asks the project which region holds the address, and sends the credential only to
 * an origin that passes the rule in `locate.ts`.
 */
import { GateClient } from "../src/index";
import { chooseLocatedOrigin } from "../src/locate";
import { __resetStore } from "../__mocks__/react-native-keychain";

const BASE = "https://acme.api-de01.k9o.io";

describe("chooseLocatedOrigin", () => {
  const ok: Array<[string, string, unknown]> = [
    ["a sibling region of the same org, family and apex", "https://acme.api-us01.k9o.io", { region: "us01", origin: "https://acme.api-us01.k9o.io" }],
    ["the base's own region", BASE, { region: "de01", origin: BASE }],
    ["a trailing slash", "https://acme.api-us01.k9o.io", { region: "us01", origin: "https://acme.api-us01.k9o.io/" }],
  ];
  for (const [name, want, answer] of ok) test(`uses ${name}`, () => expect(chooseLocatedOrigin(BASE, answer)).toBe(want));

  const refused: Array<[string, unknown]> = [
    ["null origin (single host, self-hosted)", { region: "de01", origin: null }],
    ["a missing answer", null],
    ["http", { region: "us01", origin: "http://acme.api-us01.k9o.io" }],
    ["userinfo", { region: "us01", origin: "https://u:p@acme.api-us01.k9o.io" }],
    ["a port", { region: "us01", origin: "https://acme.api-us01.k9o.io:8443" }],
    ["a path", { region: "us01", origin: "https://acme.api-us01.k9o.io/x" }],
    ["a query", { region: "us01", origin: "https://acme.api-us01.k9o.io/?a=1" }],
    ["a fragment", { region: "us01", origin: "https://acme.api-us01.k9o.io/#x" }],
    ["another org", { region: "us01", origin: "https://evil.api-us01.k9o.io" }],
    ["another apex", { region: "us01", origin: "https://acme.api-us01.evil.io" }],
    ["another family", { region: "us01", origin: "https://acme.api-staging-us01.k9o.io" }],
    ["a code that differs from region", { region: "us01", origin: "https://acme.api-fr01.k9o.io" }],
    ["a region that is not a code", { region: "usa", origin: "https://acme.api-usa.k9o.io" }],
    ["a host with no region", { region: "us01", origin: "https://acme.api.k9o.io" }],
    ["a region as a subdomain", { region: "us01", origin: "https://us01.acme.api-de01.k9o.io" }],
    ["a look-alike apex", { region: "us01", origin: "https://acme.api-us01.k9o.io.evil.io" }],
    ["an origin that is not a string", { region: "us01", origin: 5 }],
  ];
  for (const [name, answer] of refused) test(`falls back to the base for ${name}`, () => expect(chooseLocatedOrigin(BASE, answer)).toBe(BASE));

  test("allows http only when the base is http on loopback, and then only the same host", () => {
    expect(chooseLocatedOrigin("http://localhost:8080", { region: "de01", origin: "http://localhost:8080" })).toBe("http://localhost:8080");
    expect(chooseLocatedOrigin("http://localhost:8080", { region: "de01", origin: "http://evil.localhost:8080" })).toBe("http://localhost:8080");
    expect(chooseLocatedOrigin("https://localhost", { region: "de01", origin: "http://localhost" })).toBe("https://localhost");
    expect(chooseLocatedOrigin("http://localhost", { region: "de01", origin: "http://localhost" })).toBe("http://localhost");
  });

  test("uses the base when the base is not a gateway host shape", () => {
    expect(chooseLocatedOrigin("https://gw.internal.example", { region: "us01", origin: "https://gw-us01.internal.example" })).toBe("https://gw.internal.example");
  });
});

// MARK: - Flow

type Seen = { method: string; url: string; body: unknown; headers: Record<string, string> };

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const NF = { code: "K9O_NOT_FOUND", message: "x", context: {}, recommendation: null };
const session = { accessToken: "a", refreshToken: "r-1", expiresAt: "x" };
const authResult = { user: { id: "eu_1" }, session };

class Store {
  private token: string | null = null;
  async save(t: string) { this.token = t; }
  async load() { return this.token; }
  async delete() { this.token = null; }
}

function harness(answer: (u: string) => ReturnType<typeof json>) {
  const seen: Seen[] = [];
  global.fetch = jest.fn().mockImplementation(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    seen.push({ method: init?.method ?? "GET", url: String(url), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, headers: init?.headers ?? {} });
    return answer(String(url));
  });
  return { seen, client: new GateClient({ orgBaseUrl: BASE, projectSlug: "portal", tokenStore: new Store() }) };
}

beforeEach(() => __resetStore());
afterEach(() => { delete (global as Record<string, unknown>).fetch; });

describe("password sign-in through the locate door", () => {
  test("sends only the email to the door, then the password to the located origin", async () => {
    const h = harness((u) => (u.endsWith("/gate/locate") ? json(200, { data: { region: "us01", origin: "https://acme.api-us01.k9o.io" }, meta: {} }) : json(200, { data: authResult, meta: {} })));
    await h.client.signIn({ email: "a@b.co", password: "pw" });
    expect(h.seen.map((s) => s.url)).toEqual([`${BASE}/@portal/gate/locate`, "https://acme.api-us01.k9o.io/@portal/gate/signin"]);
    expect(h.seen[0]!.body).toEqual({ email: "a@b.co" });
    expect(h.seen[0]!.headers["Authorization"]).toBeUndefined();
    expect(h.seen[0]!.headers["authorization"]).toBeUndefined();
  });

  test("never sends the password to an origin that fails the rule", async () => {
    const h = harness((u) => (u.endsWith("/gate/locate") ? json(200, { data: { region: "us01", origin: "https://evil.example" }, meta: {} }) : json(200, { data: authResult, meta: {} })));
    await h.client.signIn({ email: "a@b.co", password: "pw" });
    expect(h.seen[1]!.url).toBe(`${BASE}/@portal/gate/signin`);
    expect(h.seen.some((s) => s.url.includes("evil.example"))).toBe(false);
  });

  test("uses the base when the door answers origin null", async () => {
    const h = harness((u) => (u.endsWith("/gate/locate") ? json(200, { data: { region: "de01", origin: null }, meta: {} }) : json(200, { data: authResult, meta: {} })));
    await h.client.signIn({ email: "a@b.co", password: "pw" });
    expect(h.seen[1]!.url).toBe(`${BASE}/@portal/gate/signin`);
  });

  test("uses the base when the door answers 2xx with a malformed body", async () => {
    for (const bad of ["not-json", "{}", "null"]) {
      const h = harness((u) => (u.endsWith("/gate/locate") ? { ok: true, status: 200, text: async () => bad } : json(200, { data: authResult, meta: {} })));
      await h.client.signIn({ email: "a@b.co", password: "pw" });
      expect(h.seen.map((s) => s.url)).toEqual([`${BASE}/@portal/gate/locate`, `${BASE}/@portal/gate/signin`]);
    }
  });

  test("sends nothing to sign-in when the door is down (503) or rate-limited (429), and raises the door's error", async () => {
    for (const [status, code] of [[503, "K9O_GATE_REGION_UNAVAILABLE"], [429, "K9O_RATE_LIMITED"]] as const) {
      const h = harness(() => json(status, { code, message: "x", context: {}, recommendation: null }));
      await expect(h.client.signIn({ email: "a@b.co", password: "pw" })).rejects.toMatchObject({ code: code.replace(/^K9O_/, ""), statusCode: status });
      expect(h.seen).toHaveLength(1);
    }
  });

  test("uses the base when the door answers 404, and the call succeeds", async () => {
    const h = harness((u) => (u.endsWith("/gate/locate") ? json(404, NF) : json(200, { data: authResult, meta: {} })));
    const out = await h.client.signIn({ email: "a@b.co", password: "pw" });
    expect(out.user.id).toBe("eu_1");
    expect(h.seen.map((s) => s.url)).toEqual([`${BASE}/@portal/gate/locate`, `${BASE}/@portal/gate/signin`]);
  });

  test("raises when the door answers 404 and then sign-in itself answers 404", async () => {
    const h = harness(() => json(404, NF));
    await expect(h.client.signIn({ email: "a@b.co", password: "pw" })).rejects.toMatchObject({ statusCode: 404 });
    expect(h.seen.map((s) => s.url)).toEqual([`${BASE}/@portal/gate/locate`, `${BASE}/@portal/gate/signin`]);
  });

  test("raises any other door failure as the usual error, with no retry", async () => {
    const h = harness(() => json(500, { code: "K9O_INTERNAL_ERROR", message: "x", context: {}, recommendation: null }));
    await expect(h.client.signIn({ email: "a@b.co", password: "pw" })).rejects.toMatchObject({ code: "K9O_INTERNAL_ERROR", statusCode: 500 });
    expect(h.seen).toHaveLength(1);
  });

  test("does not cache the located origin: the next sign-in asks again", async () => {
    let n = 0;
    const h = harness((u) => {
      if (!u.endsWith("/gate/locate")) return json(200, { data: authResult, meta: {} });
      const region = n++ === 0 ? "us01" : "fr01";
      return json(200, { data: { region, origin: `https://acme.api-${region}.k9o.io` }, meta: {} });
    });
    await h.client.signIn({ email: "a@b.co", password: "pw" });
    await h.client.signIn({ email: "a@b.co", password: "pw" });
    expect(h.seen.filter((s) => s.url.endsWith("/gate/locate"))).toHaveLength(2);
    expect(h.seen.map((s) => s.url).filter((u) => u.endsWith("/signin"))).toEqual(["https://acme.api-us01.k9o.io/@portal/gate/signin", "https://acme.api-fr01.k9o.io/@portal/gate/signin"]);
  });

  test("sends refresh and sign-out to the origin that issued the session", async () => {
    const h = harness((u) => (u.endsWith("/gate/locate") ? json(200, { data: { region: "us01", origin: "https://acme.api-us01.k9o.io" }, meta: {} }) : json(200, { data: u.endsWith("/signin") ? authResult : { revoked: true, accessToken: "n", refreshToken: "r-2", expiresAt: "x" }, meta: {} })));
    await h.client.signIn({ email: "a@b.co", password: "pw" });
    await h.client.refreshToken({ refreshToken: "r-1" });
    await h.client.signOut({ refreshToken: "r-2" });
    const urls = h.seen.map((s) => s.url);
    expect(urls).toContain("https://acme.api-us01.k9o.io/@portal/gate/refresh");
    expect(urls).toContain("https://acme.api-us01.k9o.io/@portal/gate/signout");
    await h.client.refreshToken({ refreshToken: "r-1" });
    expect(h.seen[h.seen.length - 1]!.url).toBe(`${BASE}/@portal/gate/refresh`);
  });

  test("keeps at most 64 session hints, dropping the oldest", async () => {
    let n = 0;
    const h = harness((u) => {
      if (u.endsWith("/gate/locate")) return json(200, { data: { region: "us01", origin: "https://acme.api-us01.k9o.io" }, meta: {} });
      if (u.endsWith("/signin")) return json(200, { data: { user: { id: "u" }, session: { ...session, refreshToken: `cap-${n++}` } }, meta: {} });
      return json(200, { data: { accessToken: "n", expiresAt: "x" }, meta: {} });
    });
    for (let i = 0; i < 65; i++) await h.client.signIn({ email: "a@b.co", password: "pw" });
    await h.client.refreshToken({ refreshToken: "cap-0" });
    expect(h.seen[h.seen.length - 1]!.url).toBe(`${BASE}/@portal/gate/refresh`);
    await h.client.refreshToken({ refreshToken: "cap-64" });
    expect(h.seen[h.seen.length - 1]!.url).toBe("https://acme.api-us01.k9o.io/@portal/gate/refresh");
  });
});
