import { describe, expect, test } from "bun:test";
import { KError } from "../src";
import { harness } from "./harness";

async function fail(body: unknown, headers: Record<string, string>): Promise<KError> {
  const { c } = harness(() => new Response(JSON.stringify(body), { status: 404, headers: { "content-type": "application/json", ...headers } }));
  try {
    await c.ai.embed({ input: "a" });
  } catch (e) {
    return e as KError;
  }
  throw new Error("expected KError");
}

describe("error request id", () => {
  const wire = { code: "K9O_NOT_FOUND", message: "m", context: {}, recommendation: null };
  test("from header when body has none", async () => {
    expect((await fail(wire, { "x-k9o-request-id": "req_abc" })).requestId).toBe("req_abc");
  });
  test("body wins over header", async () => {
    expect((await fail({ ...wire, requestId: "req_body" }, { "x-k9o-request-id": "req_hdr" })).requestId).toBe("req_body");
  });
  test("null when neither", async () => {
    expect((await fail(wire, {})).requestId).toBeNull();
  });
  test("header name in another case", async () => {
    expect((await fail(wire, { "X-K9O-Request-Id": "req_abc" })).requestId).toBe("req_abc");
  });
});
