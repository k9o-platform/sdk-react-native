import { describe, expect, test } from "bun:test";
import { KError } from "../src";
import { harness, json } from "./harness";

async function check(status: number, rec: unknown, text: string | null, wait: number | null) {
  const { c } = harness(() => json({ code: "K9O_X", message: "msg", context: { x: 1 }, recommendation: rec }, status));
  let err: unknown;
  try {
    await c.ai.embed({ input: "a" });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(KError);
  const e = err as KError;
  expect(e.code).toBe("K9O_X");
  expect(e.message).toBe("msg");
  expect(e.status).toBe(status);
  expect(e.context).toEqual({ x: 1 });
  expect(e.recommendation).toBe(text);
  expect(e.retryAfterSec).toBe(wait);
}

describe("error recommendation decoding", () => {
  test("object with action", () => check(403, { action: "Open Billing" }, "Open Billing", null));
  test("object with retryAfterSec and note", () => check(429, { retryAfterSec: 30, note: "retry" }, "retry", 30));
  test("null", () => check(429, null, null, null));
  test("string", () => check(400, "do this", "do this", null));
  test("number", () => check(400, 5, null, null));
  test("array", () => check(400, ["a", "b"], null, null));
  test("negative retryAfterSec ignored", () => check(429, { retryAfterSec: -1 }, null, null));
});
