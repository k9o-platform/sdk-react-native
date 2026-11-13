import { describe, expect, test } from "bun:test";
import { harness, json } from "./harness";

const SEARCH = "/@demo/vectors/_vec_example/search";
const UPSERT = "/@demo/vectors/_vec_example/upsert";
const hit = (id: string, score: number) => ({
  id, score, _source: { handle: "probe", chunkIndex: 0 }, contentHash: null, text: null, metadata: {}, model: null, chunk: 0,
});

describe("core.vectors.nearest", () => {
  test("posts the vector in the body and returns results closest first", async () => {
    const { c, calls } = harness(() => json({ data: { results: [hit("p1", 1), hit("p2", 0.8)], collection: "_vec_example" }, meta: {} }));
    const r = await c.vectors.nearest("_vec_example", { queryVector: [1, 0, 0], topK: 2, minScore: 0.5, metric: "dot", filters: { "metadata.lang": "en" } });
    expect([calls[0]!.method, calls[0]!.url.pathname, calls[0]!.url.search]).toEqual(["POST", SEARCH, ""]);
    expect(calls[0]!.body).toEqual({ queryVector: [1, 0, 0], topK: 2, minScore: 0.5, metric: "dot", filters: { "metadata.lang": "en" } });
    expect(r.data.collection).toBe("_vec_example");
    expect(r.data.results.map((x) => x.id)).toEqual(["p1", "p2"]);
    expect(r.data.results[0]!.contentHash).toBeNull();
    expect(r.data.results[0]!.model).toBeNull();
    expect(r.data.results[0]!.chunk).toBe(0);
  });

  test("optional fields are omitted from the body", async () => {
    const { c, calls } = harness(() => json({ data: { results: [], collection: "_vec_example" }, meta: {} }));
    await c.vectors.nearest("_vec_example", { queryVector: [1, 0, 0] });
    expect(calls[0]!.body).toEqual({ queryVector: [1, 0, 0] });
  });

  test("invalid input is refused before any request", async () => {
    const { c, calls } = harness();
    const bad: Array<[string, any]> = [
      ["notes", { queryVector: [1] }],
      ["_x", { queryVector: [] }],
      ["_x", { queryVector: new Array(16001).fill(0) }],
      ["_x", { queryVector: [1, Number.NaN] }],
      ["_x", { queryVector: [1, Infinity] }],
      ["_x", { queryVector: [1], topK: 0 }],
      ["_x", { queryVector: [1], topK: 1001 }],
      ["_x", { queryVector: [1], topK: 1.5 }],
      ["_x", { queryVector: [1], metric: "manhattan" }],
      ["_x", { queryVector: [1], minScore: Number.NaN }],
      ["_x", { queryVector: [1], filters: [] }],
    ];
    for (const [name, input] of bad) {
      await expect(c.vectors.nearest(name, input)).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    }
    expect(calls.length).toBe(0);
  });

  test("no projectSlug rejects with K9O_MISSING_PROJECT_CONTEXT", async () => {
    const { c, calls } = harness(undefined, null);
    await expect(c.vectors.nearest("_x", { queryVector: [1] })).rejects.toMatchObject({ code: "K9O_MISSING_PROJECT_CONTEXT" });
    expect(calls.length).toBe(0);
  });

  test("404 K9O_COLLECTION_NOT_FOUND decodes into a KError", async () => {
    const { c } = harness(() => json({ code: "K9O_COLLECTION_NOT_FOUND", message: "derived vector collection '_vec_example' does not exist", context: {} }, 404));
    await expect(c.vectors.nearest("_vec_example", { queryVector: [1, 0, 0] })).rejects.toMatchObject({
      name: "KError", code: "K9O_COLLECTION_NOT_FOUND", status: 404,
    });
  });

  test("400 K9O_INVALID_VECTOR_DIMENSION decodes with its context", async () => {
    const { c } = harness(() => json({
      code: "K9O_INVALID_VECTOR_DIMENSION",
      message: "query vector dimension does not match collection '_vec_example'",
      context: { collection: "_vec_example", queryDim: 2 },
    }, 400));
    await expect(c.vectors.nearest("_vec_example", { queryVector: [1, 0] })).rejects.toMatchObject({
      code: "K9O_INVALID_VECTOR_DIMENSION", status: 400, context: { collection: "_vec_example", queryDim: 2 },
    });
  });
});

describe("core.vectors.upsert", () => {
  test("posts the rows and returns the count", async () => {
    const { c, calls } = harness(() => json({ data: { upserted: 3, collection: "_vec_example" }, meta: {} }));
    const rows = [
      { id: "p1", vector: [1, 0, 0], _source: { handle: "probe", chunkIndex: 0 }, text: "x", metadata: { lang: "en" }, subjectIds: ["eu_YmGE3Z6nkv5i"] },
      { vector: [0, 1, 0], _source: { handle: "probe", chunkIndex: 1 }, contentHash: "h" },
    ];
    const r = await c.vectors.upsert("_vec_example", rows);
    expect([calls[0]!.method, calls[0]!.url.pathname]).toEqual(["POST", UPSERT]);
    expect(calls[0]!.body).toEqual({ rows });
    expect(r.data).toEqual({ upserted: 3, collection: "_vec_example" });
  });

  test("invalid input is refused before any request", async () => {
    const { c, calls } = harness();
    const src = { handle: "h", chunkIndex: 0 };
    await expect(c.vectors.upsert("notes", [{ vector: [1], _source: src }])).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    await expect(c.vectors.upsert("_x", [])).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    await expect(c.vectors.upsert("_x", new Array(1001).fill({ vector: [1], _source: src }))).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    await expect(c.vectors.upsert("_x", [{ vector: [], _source: src }])).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    await expect(c.vectors.upsert("_x", [{ vector: [Number.NaN], _source: src }])).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    expect(calls.length).toBe(0);
  });

  test("400 K9O_INVALID_VECTOR_DIMENSION decodes into a KError", async () => {
    const { c } = harness(() => json({ code: "K9O_INVALID_VECTOR_DIMENSION", message: "rows differ in length", context: { index: 1, expected: 3, got: 2 } }, 400));
    await expect(c.vectors.upsert("_x", [{ vector: [1, 2, 3], _source: { handle: "h", chunkIndex: 0 } }])).rejects.toMatchObject({
      code: "K9O_INVALID_VECTOR_DIMENSION", status: 400,
    });
  });
});
