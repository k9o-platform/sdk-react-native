import { describe, expect, test } from "bun:test";
import { harness, json } from "./harness";

const BASE = "/@demo/metadata";
const p1 = { surface: "collection:posts", scope: "posts", recordId: "p1", metadata: { title: "Quarterly report", body: "...", tags: ["pinned", "finance"], priority: 3, embedding: "[1,0,0]" } };
const telemetry = {
  surface: "telemetry:collection.metadata_index_declared", scope: "collection.metadata_index_declared", eventId: "aud_1",
  metadata: { id: "aud_1", type: "collection.metadata_index_declared", actorId: "usr_1", occurredAt: "2026-10-26T20:00:00.000Z" },
};
const queryAnswer = { data: [p1, telemetry], meta: { requestId: "r1", cursor: { next: null } } };

describe("core.metadata.filter", () => {
  test("posts surfaces, prefixes collection fields and returns rows with the next cursor", async () => {
    const { c, calls } = harness(() => json({ data: [p1], meta: { cursor: { next: "cur_1" } } }));
    const r = await c.metadata.filter({
      surfaces: ["collection:posts"],
      where: [{ field: "priority", op: "gte", value: 2 }, { field: "metadata.title", op: "startsWith", value: "Q" }],
      limit: 1,
      cursor: "cur_0",
    });
    expect([calls[0]!.method, calls[0]!.url.pathname, calls[0]!.url.search]).toEqual(["POST", `${BASE}/query`, ""]);
    expect(calls[0]!.body).toEqual({
      surfaces: ["collection:posts"],
      where: [{ field: "metadata.priority", op: "gte", value: 2 }, { field: "metadata.title", op: "startsWith", value: "Q" }],
      limit: 1,
      cursor: "cur_0",
    });
    expect(r.cursor).toBe("cur_1");
    expect(r.data[0]!.recordId).toBe("p1");
    expect(r.data[0]!.metadata["priority"]).toBe(3);
  });

  test("sends only the surfaces when nothing else is given, and reports a null cursor", async () => {
    const { c, calls } = harness(() => json(queryAnswer));
    const r = await c.metadata.filter({ surfaces: ["collection:posts", "telemetry:collection.metadata_index_declared"] });
    expect(calls[0]!.body).toEqual({ surfaces: ["collection:posts", "telemetry:collection.metadata_index_declared"] });
    expect(r.cursor).toBeNull();
    expect(r.data[1]!.eventId).toBe("aud_1");
  });

  test("leaves createdAt and actorId bare when a telemetry surface is named", async () => {
    const { c, calls } = harness(() => json(queryAnswer));
    await c.metadata.filter({
      surfaces: ["telemetry:collection."],
      where: [{ field: "createdAt", op: "gt", value: "2026-10-26T00:00:00Z" }, { field: "actorId", op: "eq", value: "usr_1" }],
    });
    expect((calls[0]!.body as { where: unknown }).where).toEqual([
      { field: "createdAt", op: "gt", value: "2026-10-26T00:00:00Z" },
      { field: "actorId", op: "eq", value: "usr_1" },
    ]);
  });

  test("lets a storage surface through and decodes the 501", async () => {
    const { c, calls } = harness(() => json({ code: "K9O_NOT_IMPLEMENTED", message: "storage metadata is not available", context: { surface: "storage:photos" } }, 501));
    await expect(c.metadata.filter({ surfaces: ["storage:photos"] })).rejects.toMatchObject({
      code: "K9O_NOT_IMPLEMENTED", status: 501, context: { surface: "storage:photos" },
    });
    expect(calls[0]!.body).toEqual({ surfaces: ["storage:photos"] });
  });

  test("decodes the 413 and the 400 not-indexed answers", async () => {
    const big = harness(() => json({ code: "K9O_QUERY_RESULT_TOO_LARGE", message: "too many rows", context: { cap: 10000, surfaces: ["collection:posts"] }, recommendation: "Add where or lower limit." }, 413));
    await expect(big.c.metadata.filter({ surfaces: ["collection:posts"] })).rejects.toMatchObject({
      code: "K9O_QUERY_RESULT_TOO_LARGE", status: 413, context: { cap: 10000 }, recommendation: "Add where or lower limit.",
    });
    const nope = harness(() => json({ code: "K9O_METADATA_FIELD_NOT_INDEXED", message: "not declared", context: { surface: "collection:posts", field: "metadata.secret" }, recommendation: { action: "declare it" } }, 400));
    await expect(nope.c.metadata.filter({ surfaces: ["collection:posts"], where: [{ field: "secret", op: "eq", value: 1 }] })).rejects.toMatchObject({
      code: "K9O_METADATA_FIELD_NOT_INDEXED", status: 400, context: { field: "metadata.secret" }, recommendation: "declare it",
    });
    const denied = harness(() => json({ code: "K9O_EXTENSION_PERMISSION_DENIED", message: "no grant", context: { surface: "collection:posts" } }, 403));
    await expect(denied.c.metadata.filter({ surfaces: ["collection:posts"] })).rejects.toMatchObject({ code: "K9O_EXTENSION_PERMISSION_DENIED", status: 403 });
  });

  test("refuses bad input before sending anything", async () => {
    const { c, calls } = harness(() => json(queryAnswer));
    const bad: Array<any> = [
      { surfaces: [] },
      { surfaces: ["posts"] },
      { surfaces: ["table:posts"] },
      { surfaces: ["collection:"] },
      { surfaces: ["collection:1posts"] },
      { surfaces: ["collection:posts", "telemetry:x"], cursor: "c" },
      { surfaces: ["collection:posts"], limit: 0 },
      { surfaces: ["collection:posts"], limit: 1001 },
      { surfaces: ["collection:posts"], limit: 1.5 },
      { surfaces: ["collection:posts"], where: [{ field: "a", op: "like" }] },
      { surfaces: ["collection:posts"], where: [{ field: "", op: "eq" }] },
      { surfaces: ["collection:posts"], where: "x" },
    ];
    for (const input of bad) await expect(c.metadata.filter(input)).rejects.toMatchObject({ name: "KError" });
    await expect(c.metadata.filter({ surfaces: ["posts"] })).rejects.toMatchObject({ code: "K9O_UNKNOWN_SURFACE" });
    expect(calls.length).toBe(0);
  });

  test("no projectSlug rejects with K9O_MISSING_PROJECT_CONTEXT", async () => {
    const { c, calls } = harness(undefined, null);
    await expect(c.metadata.filter({ surfaces: ["collection:posts"] })).rejects.toMatchObject({ code: "K9O_MISSING_PROJECT_CONTEXT" });
    expect(calls.length).toBe(0);
  });
});

describe("core.metadata.set", () => {
  test("patches the record with the bare columns and returns the whole row", async () => {
    const row = { id: "p2", title: "Team offsite 2027", priority: 9, secret: "s2" };
    const { c, calls } = harness(() => json({ data: row, meta: { requestId: "r2" } }));
    const r = await c.metadata.set("posts", "p 2", { title: "Team offsite 2027", "metadata.priority": 9 });
    expect([calls[0]!.method, calls[0]!.url.pathname]).toEqual(["PATCH", `${BASE}/collection/posts/p%202`]);
    expect(calls[0]!.body).toEqual({ metadata: { title: "Team offsite 2027", priority: 9 } });
    expect(r.data).toEqual(row);
  });

  test("refuses bad input before sending anything", async () => {
    const { c, calls } = harness(() => json({ data: {}, meta: {} }));
    await expect(c.metadata.set("bad-name", "p1", { a: 1 })).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    await expect(c.metadata.set("posts", "", { a: 1 })).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    await expect(c.metadata.set("posts", "p1", {})).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    await expect(c.metadata.set("posts", "p1", [] as any)).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    expect(calls.length).toBe(0);
  });

  test("decodes the not-declared answer", async () => {
    const { c } = harness(() => json({ code: "K9O_METADATA_FIELD_NOT_INDEXED", message: "x", context: { field: "metadata.nope" } }, 400));
    await expect(c.metadata.set("posts", "p1", { nope: 1 })).rejects.toMatchObject({ code: "K9O_METADATA_FIELD_NOT_INDEXED" });
  });
});

describe("core.metadata.search", () => {
  const answer = {
    data: [{ surface: "collection:posts", scope: "posts", recordId: "p3", metadata: { title: "Budget draft", body: "draft budget, finance review" } }],
    meta: { cursor: { next: null } },
  };

  test("posts surface, prefixed field, q and limit", async () => {
    const { c, calls } = harness(() => json(answer));
    const r = await c.metadata.search({ surface: "collection:posts", field: "body", q: "finance", limit: 5 });
    expect([calls[0]!.method, calls[0]!.url.pathname]).toEqual(["POST", `${BASE}/search`]);
    expect(calls[0]!.body).toEqual({ surface: "collection:posts", field: "metadata.body", q: "finance", limit: 5 });
    expect(r.data.map((x) => x.recordId)).toEqual(["p3"]);
    expect(r.cursor).toBeNull();
  });

  test("keeps an existing prefix and omits limit", async () => {
    const { c, calls } = harness(() => json(answer));
    await c.metadata.search({ surface: "collection:posts", field: "metadata.body", q: "x" });
    expect(calls[0]!.body).toEqual({ surface: "collection:posts", field: "metadata.body", q: "x" });
  });

  test("refuses bad input before sending anything", async () => {
    const { c, calls } = harness(() => json(answer));
    const base = { surface: "collection:posts", field: "body", q: "a" };
    for (const input of [{ ...base, surface: "telemetry:x" }, { ...base, surface: "storage:b" }, { ...base, field: "" }, { ...base, q: "" }, { ...base, limit: 2000 }]) {
      await expect(c.metadata.search(input)).rejects.toMatchObject({ name: "KError" });
    }
    expect(calls.length).toBe(0);
  });

  test("decodes the encrypted-column answer", async () => {
    const { c } = harness(() => json({ code: "K9O_ENCRYPTED_COLUMN_OPERATION_UNSUPPORTED", message: "x", context: { column: "body", op: "textSearch" } }, 400));
    await expect(c.metadata.search({ surface: "collection:posts", field: "body", q: "a" })).rejects.toMatchObject({ code: "K9O_ENCRYPTED_COLUMN_OPERATION_UNSUPPORTED" });
  });
});

describe("core.metadata.vectors.nearest", () => {
  const answer = { data: [{ surface: "collection:posts", scope: "posts", recordId: "p1", metadata: { title: "Quarterly report", embedding: "[1,0,0]" } }], meta: { cursor: { next: null } } };

  test("posts the prefixed column, the embedding and the options", async () => {
    const { c, calls } = harness(() => json(answer));
    const r = await c.metadata.vectors.nearest({
      surface: "collection:posts", column: "embedding", embedding: [1, 0, 0], k: 3, metric: "dot",
      where: [{ field: "priority", op: "gt", value: 1 }],
    });
    expect([calls[0]!.method, calls[0]!.url.pathname]).toEqual(["POST", `${BASE}/vectors/nearest`]);
    expect(calls[0]!.body).toEqual({
      surface: "collection:posts", column: "metadata.embedding", embedding: [1, 0, 0], k: 3, metric: "dot",
      where: [{ field: "metadata.priority", op: "gt", value: 1 }],
    });
    expect(r.data[0]!.recordId).toBe("p1");
  });

  test("sends only the required fields by default", async () => {
    const { c, calls } = harness(() => json(answer));
    await c.metadata.vectors.nearest({ surface: "collection:posts", column: "metadata.embedding", embedding: [0.5] });
    expect(calls[0]!.body).toEqual({ surface: "collection:posts", column: "metadata.embedding", embedding: [0.5] });
  });

  test("refuses bad input before sending anything", async () => {
    const { c, calls } = harness(() => json(answer));
    const base = { surface: "collection:posts", column: "embedding", embedding: [1] };
    const bad: Array<any> = [
      { ...base, embedding: [] }, { ...base, embedding: [1, Number.NaN] }, { ...base, embedding: [Infinity] }, { ...base, k: 0 }, { ...base, k: 1001 },
      { ...base, metric: "l2" }, { ...base, surface: "telemetry:x" }, { ...base, column: "" },
    ];
    for (const input of bad) await expect(c.metadata.vectors.nearest(input)).rejects.toMatchObject({ name: "KError" });
    expect(calls.length).toBe(0);
  });
});

describe("core.metadata.index", () => {
  const index = { data: { collection: "posts", columns: [{ column: "body", indexed: false }, { column: "tags", indexed: true }] }, meta: {} };

  test("gets the declaration", async () => {
    const { c, calls } = harness(() => json(index));
    const r = await c.metadata.index.get("posts");
    expect([calls[0]!.method, calls[0]!.url.pathname]).toEqual(["GET", `${BASE}/index/posts`]);
    expect(calls[0]!.body).toBeUndefined();
    expect(r.data.columns[1]).toEqual({ column: "tags", indexed: true });
  });

  test("declares columns with PUT", async () => {
    const { c, calls } = harness(() => json(index));
    await c.metadata.index.declare("posts", [{ column: "body" }, { column: "tags", indexed: true }]);
    expect([calls[0]!.method, calls[0]!.url.pathname]).toEqual(["PUT", `${BASE}/index/posts`]);
    expect(calls[0]!.body).toEqual({ columns: [{ column: "body" }, { column: "tags", indexed: true }] });
  });

  test("clears the declaration with an empty list and accepts 64 columns", async () => {
    const { c, calls } = harness(() => json(index));
    await c.metadata.index.declare("posts", []);
    await c.metadata.index.declare("posts", Array.from({ length: 64 }, (_, i) => ({ column: `c${i}` })));
    expect((calls[0]!.body as { columns: unknown[] }).columns).toEqual([]);
    expect((calls[1]!.body as { columns: unknown[] }).columns.length).toBe(64);
  });

  test("refuses more than 64 columns, id, repeats and bad names before sending anything", async () => {
    const { c, calls } = harness(() => json(index));
    await expect(c.metadata.index.declare("posts", Array.from({ length: 65 }, (_, i) => ({ column: `c${i}` })))).rejects.toMatchObject({ name: "KError" });
    await expect(c.metadata.index.declare("posts", [{ column: "id" }])).rejects.toMatchObject({ name: "KError" });
    await expect(c.metadata.index.declare("posts", [{ column: "a" }, { column: "a" }])).rejects.toMatchObject({ name: "KError" });
    await expect(c.metadata.index.declare("posts", [{ column: "a b" }])).rejects.toMatchObject({ name: "KError" });
    await expect(c.metadata.index.declare("posts", [{ column: "a", indexed: "yes" as any }])).rejects.toMatchObject({ name: "KError" });
    await expect(c.metadata.index.declare("bad-name", [])).rejects.toMatchObject({ name: "KError" });
    await expect(c.metadata.index.get("bad-name")).rejects.toMatchObject({ name: "KError" });
    expect(calls.length).toBe(0);
  });

  test("decodes a missing collection and a refused role", async () => {
    const missing = harness(() => json({ code: "K9O_COLLECTION_NOT_FOUND", message: "x" }, 404));
    await expect(missing.c.metadata.index.declare("ghost", [])).rejects.toMatchObject({ status: 404, code: "K9O_COLLECTION_NOT_FOUND" });
    const denied = harness(() => json({ code: "K9O_IAM_POLICY_DENIED", message: "x" }, 403));
    await expect(denied.c.metadata.index.declare("posts", [])).rejects.toMatchObject({ code: "K9O_IAM_POLICY_DENIED" });
  });
});
