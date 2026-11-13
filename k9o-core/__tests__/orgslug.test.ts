import { describe, expect, test } from "bun:test";
import { CoreClient, type FetchLike } from "../src";
import { KError } from "../src/KError";
import { resolveBaseUrl } from "../src/region";

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
  for (const [base, slug, want] of unchanged) {
    test(`${base} + ${slug ?? "no slug"} is used as given`, () => expect(resolveBaseUrl(base, slug)).toBe(want));
  }

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
    for (const bad of ["Acme", "acme-"]) {
      let err: unknown;
      try { resolveBaseUrl(undefined, bad); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(KError);
      expect((err as KError).code).toBe("K9O_INVALID_FIELD_VALUE");
      expect((err as KError).context).toEqual({ field: "orgSlug", slug: bad });
    }
  });

  test("a slug is not checked when the base URL is used as given", () => {
    expect(resolveBaseUrl("https://acme.api.k9o.io", "BAD-")).toBe("https://acme.api.k9o.io");
  });

  test("neither is an invalid base URL, never the bare apex", () => {
    expect(() => resolveBaseUrl(undefined)).toThrow(expect.objectContaining({ code: "K9O_INVALID_BASE_URL" }));
    expect(() => resolveBaseUrl("  ", undefined)).toThrow(expect.objectContaining({ code: "K9O_INVALID_BASE_URL" }));
    expect(() => new CoreClient({})).toThrow(expect.objectContaining({ code: "K9O_INVALID_BASE_URL" }));
    for (const call of [() => resolveBaseUrl(undefined), () => new CoreClient({})]) {
      let err: unknown;
      try { call(); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(KError);
      expect((err as KError).code).toBe("K9O_INVALID_BASE_URL");
      expect((err as KError).context).toEqual({ field: "baseUrl" });
    }
  });
});

describe("CoreClient with orgSlug", () => {
  test("a request goes to the composed host", async () => {
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ data: [], meta: {} }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const c = new CoreClient({ orgSlug: "acme", projectSlug: "demo", accessToken: "t", fetch });
    await c.query("select 1");
    expect(urls[0]).toBe("https://acme.api.k9o.io/");
    expect(urls.some((u) => u.startsWith("https://acme.api.k9o.io/@demo/"))).toBe(true);
    const d = new CoreClient({ baseUrl: "https://api.k9o.io", orgSlug: "beta", projectSlug: "demo", accessToken: "t", fetch });
    await d.query("select 1");
    expect(urls.some((u) => u.startsWith("https://beta.api.k9o.io/@demo/"))).toBe(true);
  });
});
