import { GateClient, GateError } from "../src/index";
import { resolveBaseUrl } from "../src/region";
import { __resetStore } from "../__mocks__/react-native-keychain";

describe("resolveBaseUrl", () => {
  const unchanged: Array<[string, string | undefined, string]> = [
    ["https://acme.api.k9o.io", undefined, "https://acme.api.k9o.io"],
    ["https://acme.api.k9o.io/", "acme", "https://acme.api.k9o.io"],
    ["https://acme.api.k9o.io", "other", "https://acme.api.k9o.io"],
    ["https://acme.api-de01.k9o.io", "acme", "https://acme.api-de01.k9o.io"],
    ["https://api-de01.k9o.io", "acme", "https://api-de01.k9o.io"],
    ["https://auth.example.com", undefined, "https://auth.example.com"],
    ["https://auth.example.com", "acme", "https://auth.example.com"],
    ["http://localhost:3000", "acme", "http://localhost:3000"],
    ["http://127.0.0.1:8080", "acme", "http://127.0.0.1:8080"],
    ["https://gateway.corp.internal", "acme", "https://gateway.corp.internal"],
  ];
  test.each(unchanged)("%s + %s is used as given", (base, slug, want) => {
    expect(resolveBaseUrl(base, slug)).toBe(want);
  });

  test("platform host + slug composes the org host", () => {
    expect(resolveBaseUrl("https://api.k9o.io", "acme")).toBe("https://acme.api.k9o.io");
    expect(resolveBaseUrl("https://api.k9o.io/", "acme")).toBe("https://acme.api.k9o.io");
    expect(resolveBaseUrl("https://api-staging.corp.internal", "acme")).toBe("https://acme.api-staging.corp.internal");
    expect(resolveBaseUrl("http://api.example.test:8443", "acme")).toBe("http://acme.api.example.test:8443");
  });

  test("platform host with no slug is used as given", () => {
    expect(resolveBaseUrl("https://api.k9o.io", undefined)).toBe("https://api.k9o.io");
  });

  test("slug only gives the public-cloud org host", () => {
    expect(resolveBaseUrl(undefined, "acme")).toBe("https://acme.api.k9o.io");
    expect(resolveBaseUrl("", "acme")).toBe("https://acme.api.k9o.io");
  });

  test("a bad slug is refused", () => {
    for (const bad of ["Acme", "acme-", "a", "a".repeat(64), "1acme"]) {
      expect(() => resolveBaseUrl(undefined, bad)).toThrow(expect.objectContaining({ code: "K9O_INVALID_FIELD_VALUE" }));
      expect(() => resolveBaseUrl("https://api.k9o.io", bad)).toThrow(expect.objectContaining({ code: "K9O_INVALID_FIELD_VALUE" }));
    }
  });

  test("a bad slug carries the field and the value in its context", () => {
    for (const bad of ["Acme", "acme-"]) {
      let err: unknown;
      try { resolveBaseUrl(undefined, bad); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(GateError);
      expect((err as GateError).code).toBe("K9O_INVALID_FIELD_VALUE");
      expect((err as GateError).context).toEqual({ field: "orgSlug", slug: bad });
    }
  });

  test("a slug is not checked when the base URL is used as given", () => {
    expect(resolveBaseUrl("https://acme.api.k9o.io", "BAD-")).toBe("https://acme.api.k9o.io");
  });

  test("neither is an invalid base URL, never the bare apex", () => {
    expect(() => resolveBaseUrl(undefined)).toThrow(expect.objectContaining({ code: "K9O_INVALID_BASE_URL" }));
    expect(() => resolveBaseUrl("  ", undefined)).toThrow(expect.objectContaining({ code: "K9O_INVALID_BASE_URL" }));
    expect(() => new GateClient({ projectSlug: "portal" })).toThrow(expect.objectContaining({ code: "K9O_INVALID_BASE_URL" }));
    for (const call of [() => resolveBaseUrl(undefined), () => new GateClient({ projectSlug: "portal" })]) {
      let err: unknown;
      try { call(); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(GateError);
      expect((err as GateError).code).toBe("K9O_INVALID_BASE_URL");
      expect((err as GateError).context).toEqual({ field: "baseUrl" });
    }
  });
});

describe("GateClient with orgSlug", () => {
  beforeEach(() => __resetStore());

  class Store {
    private token: string | null = null;
    async save(t: string) { this.token = t; }
    async load() { return this.token; }
    async delete() { this.token = null; }
  }

  test("requests go to the composed host", async () => {
    const urls: string[] = [];
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      urls.push(String(url));
      const body = String(url).endsWith("/gate/locate") ? { data: { region: null, origin: null }, meta: {} } : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    });
    const client = new GateClient({ orgSlug: "acme", projectSlug: "portal", tokenStore: new Store() });
    await client.signIn({ email: "user@example.com", password: "pw" }).catch(() => undefined);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u.startsWith("https://acme.api.k9o.io/")).toBe(true);
    expect(urls.some((u) => u === "https://acme.api.k9o.io/@portal/gate/locate")).toBe(true);
  });
});
