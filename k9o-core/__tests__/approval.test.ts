import { describe, expect, test } from "bun:test";
import { isQueuedWrite } from "../src";
import { harness, json } from "./harness";

const queued = (operation: string, targetRecordId: string | null, proposedPayload: Record<string, unknown>) =>
  json(
    {
      data: {
        id: "apr_5oLshD2MVT27",
        status: "pending_approval",
        collection: "conformance_kv",
        operation,
        makerId: "usr_conformance0001",
        proposedPayload,
        targetRecordId,
      },
      meta: {
        cost: {},
        timing: {},
        context: { requestId: "req_1", traceId: "req_1", projectId: "proj_1" },
        approval: { status: "pending_approval" },
      },
    },
    202,
  );

describe("requireApproval", () => {
  test("insert sends ?requireApproval=true and decodes the 202 queued change", async () => {
    const record = { id: "contract2-probe-0001", val: "contract2-probe" };
    const { c, calls } = harness(() => queued("insert", null, record));
    const r = await c.from("conformance_kv").insert(record).requireApproval();
    expect([calls[0]!.method, calls[0]!.url.pathname, calls[0]!.url.search]).toEqual([
      "POST",
      "/@demo/data/conformance_kv",
      "?requireApproval=true",
    ]);
    expect(calls[0]!.body).toEqual(record);
    expect(isQueuedWrite(r)).toBe(true);
    if (isQueuedWrite(r)) {
      expect(r.data.id).toBe("apr_5oLshD2MVT27");
      expect(r.data.status).toBe("pending_approval");
      expect(r.data.operation).toBe("insert");
      expect(r.data.makerId).toBe("usr_conformance0001");
      expect(r.data.proposedPayload).toEqual(record);
      expect(r.data.targetRecordId).toBeNull();
      expect(r.meta.approval.status).toBe("pending_approval");
    }
  });

  test("insert decodes the applied row when an auto_approve policy applied the write", async () => {
    const { c, calls } = harness(() => json({ data: { id: "r1", val: "x" }, meta: {} }, 201));
    const r = await c.from("conformance_kv").insert({ id: "r1", val: "x" }).requireApproval();
    expect(calls[0]!.url.search).toBe("?requireApproval=true");
    expect(isQueuedWrite(r)).toBe(false);
    if (!isQueuedWrite(r)) expect(r.data).toEqual({ id: "r1", val: "x" });
  });

  test("update sends the flag and a queued answer carries the target record", async () => {
    const { c, calls } = harness(() => queued("update", "r 1", { val: "n" }));
    const r = await c.from("conformance_kv").update({ val: "n" }).eq("id", "r 1").requireApproval();
    expect([calls[0]!.method, calls[0]!.url.pathname, calls[0]!.url.search]).toEqual([
      "PATCH",
      "/@demo/data/conformance_kv/r%201",
      "?requireApproval=true",
    ]);
    expect(calls[0]!.body).toEqual({ val: "n" });
    expect(isQueuedWrite(r)).toBe(true);
    if (isQueuedWrite(r)) expect([r.data.operation, r.data.targetRecordId]).toEqual(["update", "r 1"]);
  });

  test("update decodes the applied row", async () => {
    const { c } = harness(() => json({ data: { id: "r1", val: "n" }, meta: {} }));
    const r = await c.from("conformance_kv").update({ val: "n" }).eq("id", "r1").requireApproval();
    expect(isQueuedWrite(r)).toBe(false);
  });

  test("delete sends the flag with no body; a queued delete has an empty payload", async () => {
    const { c, calls } = harness(() => queued("delete", "r1", {}));
    const r = await c.from("conformance_kv").delete().eq("id", "r1").requireApproval();
    expect([calls[0]!.method, calls[0]!.url.pathname, calls[0]!.url.search]).toEqual([
      "DELETE",
      "/@demo/data/conformance_kv/r1",
      "?requireApproval=true",
    ]);
    expect(calls[0]!.body).toBeUndefined();
    expect(isQueuedWrite(r)).toBe(true);
    if (isQueuedWrite(r)) expect([r.data.operation, r.data.proposedPayload]).toEqual(["delete", {}]);
  });

  test("delete decodes the applied answer", async () => {
    const { c } = harness(() => json({ data: { id: "r1" }, meta: {} }));
    const r = await c.from("conformance_kv").delete().eq("id", "r1").requireApproval();
    expect(isQueuedWrite(r)).toBe(false);
  });

  test("writes without requireApproval() send no query", async () => {
    const { c, calls } = harness(() => json({ data: { id: "r1" }, meta: {} }));
    await c.from("conformance_kv").insert({ id: "r1" });
    await c.from("conformance_kv").update({ a: 1 }).eq("id", "r1");
    await c.from("conformance_kv").delete().eq("id", "r1");
    expect(calls.map((x) => x.url.search)).toEqual(["", "", ""]);
  });

  test("a requireApproval write still checks the id filter before any request", async () => {
    const { c, calls } = harness();
    await expect(Promise.resolve(c.from("notes").update({ a: 1 }).requireApproval())).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    expect(calls.length).toBe(0);
  });
});
