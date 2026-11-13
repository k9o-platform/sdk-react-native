import { describe, expect, it } from "bun:test";
import { CoreClient, KError, type FetchLike } from "../src";

interface Captured { calls: number; url: string; method: string; auth: string | undefined; body: string | undefined }

function stub(cap: Captured, response: unknown, status = 200): FetchLike {
  return async (url, init) => {
    cap.calls++;
    cap.url = url;
    cap.method = init?.method ?? "";
    cap.auth = init?.headers?.["authorization"];
    cap.body = init?.body;
    return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
  };
}
const fresh = (): Captured => ({ calls: 0, url: "", method: "", auth: undefined, body: undefined });
const OK = { data: { embeddings: [[0.1, 0.2]], model: "nomic-embed-text-v1.5", dimensions: 2 }, meta: {} };
const mk = (cap: Captured, response: unknown = OK, status = 200) =>
  new CoreClient({ baseUrl: "https://acme.api.k9o.io", projectSlug: "member-portal", accessToken: "tok-1", fetch: stub(cap, response, status) });

describe("ai.embed", () => {
  it("POSTs /@<slug>/ai/embeddings with Bearer and returns vectors", async () => {
    const cap = fresh();
    const r = await mk(cap).ai.embed({ input: "hello" });
    expect(cap.method).toBe("POST");
    expect(cap.url).toBe("https://acme.api.k9o.io/@member-portal/ai/embeddings");
    expect(cap.auth).toBe("Bearer tok-1");
    expect(r.data.embeddings).toEqual([[0.1, 0.2]]);
    expect(r.data.dimensions).toBe(2);
    expect(r.meta).toEqual({});
  });

  it("keeps a single string a string", async () => {
    const cap = fresh();
    await mk(cap).ai.embed({ input: "hello" });
    expect(JSON.parse(cap.body!)).toEqual({ input: "hello" });
  });

  it("sends list input and model as given", async () => {
    const cap = fresh();
    await mk(cap).ai.embed({ model: "nomic-embed-text-v1.5", input: ["a", "b"] });
    expect(JSON.parse(cap.body!)).toEqual({ model: "nomic-embed-text-v1.5", input: ["a", "b"] });
  });

  it("omits model when not given", async () => {
    const cap = fresh();
    await mk(cap).ai.embed({ input: ["x"] });
    expect("model" in JSON.parse(cap.body!)).toBe(false);
  });

  it("supports an async token provider", async () => {
    const cap = fresh();
    const c = new CoreClient({ baseUrl: "https://acme.api.k9o.io", projectSlug: "p", accessToken: async () => "tok-2", fetch: stub(cap, OK) });
    await c.ai.embed({ input: "x" });
    expect(cap.auth).toBe("Bearer tok-2");
  });

  it("refuses a missing projectSlug with no request sent", async () => {
    const cap = fresh();
    const c = new CoreClient({ baseUrl: "https://acme.api.k9o.io", fetch: stub(cap, OK) });
    let caught: unknown;
    try { await c.ai.embed({ input: "x" }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(KError);
    expect((caught as KError).code).toBe("K9O_MISSING_PROJECT_CONTEXT");
    expect(cap.calls).toBe(0);
  });

  it("surfaces a flat 4xx body as KError without the input text", async () => {
    const cap = fresh();
    const wire = { code: "K9O_MODEL_NOT_DECLARED", message: "model is not a declared embedding model", context: { declared: ["m"] }, recommendation: "use a declared model" };
    const secret = "the-secret-document-body";
    let caught: unknown;
    try { await mk(cap, wire, 400).ai.embed({ model: "other", input: secret }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(KError);
    const e = caught as KError;
    expect(e.code).toBe("K9O_MODEL_NOT_DECLARED");
    expect(e.status).toBe(400);
    expect(e.recommendation).toBe("use a declared model");
    expect(e.context).toEqual({ declared: ["m"] });
    expect(`${e.message} ${String(e)} ${JSON.stringify(e.context)} ${e.stack ?? ""}`).not.toContain(secret);
  });

  it("maps a network failure to K9O_UPSTREAM_UNAVAILABLE", async () => {
    const c = new CoreClient({ baseUrl: "https://acme.api.k9o.io", projectSlug: "p", fetch: async () => { throw new TypeError("offline"); } });
    let caught: unknown;
    try { await c.ai.embed({ input: "secret-text" }); } catch (e) { caught = e; }
    expect((caught as KError).code).toBe("K9O_UPSTREAM_UNAVAILABLE");
    expect(String(caught)).not.toContain("secret-text");
  });

  it("maps a non-JSON error body to K9O_INTERNAL_ERROR", async () => {
    const f: FetchLike = async () => new Response("<html>bad gateway</html>", { status: 502 });
    const c = new CoreClient({ baseUrl: "https://acme.api.k9o.io", projectSlug: "p", fetch: f });
    let caught: unknown;
    try { await c.ai.embed({ input: "x" }); } catch (e) { caught = e; }
    expect((caught as KError).code).toBe("K9O_INTERNAL_ERROR");
    expect((caught as KError).status).toBe(502);
  });
});
