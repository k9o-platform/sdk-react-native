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
const OK = {
  data: {
    modelId: "llama-3.1-8b",
    content: "Hello there",
    finishReason: "stop",
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    usageType: "chat",
  },
  meta: {},
};
const mk = (cap: Captured, response: unknown = OK, status = 200) =>
  new CoreClient({ baseUrl: "https://acme.api.k9o.io", projectSlug: "member-portal", accessToken: "tok-1", fetch: stub(cap, response, status) });

describe("ai.generate", () => {
  it("POSTs a flat body to the generate path and parses the response", async () => {
    const cap = fresh();
    const r = await mk(cap).ai.generate("hi", { model: "llama-3.1-8b", maxTokens: 10, temperature: 0.2 });
    expect(cap.method).toBe("POST");
    expect(cap.url).toBe("https://acme.api.k9o.io/@member-portal/ai/generate");
    expect(cap.auth).toBe("Bearer tok-1");
    expect(JSON.parse(cap.body!)).toEqual({ prompt: "hi", model: "llama-3.1-8b", maxTokens: 10, temperature: 0.2 });
    expect(r.data.modelId).toBe("llama-3.1-8b");
    expect(r.data.content).toBe("Hello there");
    expect(r.data.finishReason).toBe("stop");
    expect(r.data.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  });

  it("omits optional params when not given", async () => {
    const cap = fresh();
    await mk(cap).ai.generate("p");
    expect(JSON.parse(cap.body!)).toEqual({ prompt: "p" });
  });

  it("refuses a missing projectSlug with no request sent", async () => {
    const cap = fresh();
    const c = new CoreClient({ baseUrl: "https://acme.api.k9o.io", fetch: stub(cap, OK) });
    await expect(c.ai.generate("p")).rejects.toMatchObject({ code: "K9O_MISSING_PROJECT_CONTEXT" });
    expect(cap.calls).toBe(0);
  });

  it("surfaces a 501 as KError without the prompt", async () => {
    const cap = fresh();
    const secret = "the-secret-prompt";
    const err = { code: "K9O_NOT_IMPLEMENTED", message: "external provider not built", context: {}, recommendation: null };
    try {
      await mk(cap, err, 501).ai.generate(secret, { model: "gpt-4o" });
      throw new Error("expected KError");
    } catch (e) {
      expect(e).toBeInstanceOf(KError);
      const k = e as KError;
      expect(k.code).toBe("K9O_NOT_IMPLEMENTED");
      expect(k.status).toBe(501);
      expect(String(k.message)).not.toContain(secret);
    }
  });

  it("surfaces a 400 no-default-model as KError and sends no model", async () => {
    const cap = fresh();
    const err = { code: "K9O_INVALID_FIELD_VALUE", message: "Name a model: this org has no default LLM", context: { field: "model" }, recommendation: null };
    try {
      await mk(cap, err, 400).ai.generate("hi");
      throw new Error("expected KError");
    } catch (e) {
      expect(e).toBeInstanceOf(KError);
      expect((e as KError).code).toBe("K9O_INVALID_FIELD_VALUE");
      expect((e as KError).status).toBe(400);
    }
    expect(JSON.parse(cap.body!)).toEqual({ prompt: "hi" });
  });
});

describe("ai.generate usageType", () => {
  it("usageType is sent when given and omitted otherwise", async () => {
    const cap = fresh();
    const c = new CoreClient({ baseUrl: "https://acme.api-de01.k9o.io", projectSlug: "p", accessToken: "t", fetch: stub(cap, OK) });
    await c.ai.generate("hi", { usageType: "chat" });
    expect(JSON.parse(cap.body!)).toEqual({ prompt: "hi", usageType: "chat" });
    await c.ai.generate("hi");
    expect(JSON.parse(cap.body!)).toEqual({ prompt: "hi" });
  });
});
