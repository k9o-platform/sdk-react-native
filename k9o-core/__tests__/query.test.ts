import { describe, expect, test } from "bun:test";
import { KError, translateNamedParams } from "../src";
import { harness } from "./harness";

describe("translateNamedParams (shared vectors)", () => {
  const ok = (sql: string, named: Record<string, unknown>, out: string, params: unknown[]) =>
    expect(translateNamedParams(sql, named)).toEqual({ sql: out, params });
  test("1 role", () => ok("SELECT * FROM users WHERE data->>'role' = :role", { role: "admin" }, "SELECT * FROM users WHERE data->>'role' = $1", ["admin"]));
  test("2 reuse", () => ok("SELECT :a, :b, :a", { a: 1, b: 2 }, "SELECT $1, $2, $1", [1, 2]));
  test("3 quotes and casts", () =>
    ok(`SELECT ':not_a_param', ":also_not", x::int FROM t WHERE y = :y`, { y: true }, `SELECT ':not_a_param', ":also_not", x::int FROM t WHERE y = $1`, [true]));
  test("4 escaped quote and line comment", () =>
    ok("SELECT 'it''s :no' , :v -- :comment\nFROM t", { v: null }, "SELECT 'it''s :no' , $1 -- :comment\nFROM t", [null]));
  test("5 nested block comment", () => ok("SELECT /* :c /* :d */ :e */ :f", { f: 1 }, "SELECT /* :c /* :d */ :e */ $1", [1]));
  test("6 dollar quoting", () => ok("SELECT $$ :x $$, $q$ :y $q$, :z", { z: "s" }, "SELECT $$ :x $$, $q$ :y $q$, $1", ["s"]));
  test("7 array slice and a:b", () => ok("SELECT arr[1:2], a:b, :n", { n: 5 }, "SELECT arr[1:2], a:b, $1", [5]));
  test("8 missing", () => {
    try {
      translateNamedParams("SELECT :missing", {});
      throw new Error("no throw");
    } catch (e) {
      expect(e).toBeInstanceOf(KError);
      expect((e as KError).code).toBe("K9O_INVALID_FIELD_VALUE");
      expect((e as KError).message).toContain(":missing");
    }
  });
  test("9 non-bindable value", () => {
    for (const bad of [{}, [1], new Date(), undefined, Number.NaN]) {
      try {
        translateNamedParams("SELECT :a", { a: bad });
        throw new Error("no throw");
      } catch (e) {
        expect(e).toBeInstanceOf(KError);
        expect((e as KError).code).toBe("K9O_INVALID_FIELD_VALUE");
      }
    }
  });
  test("escape string with backslash quote", () =>
    ok("SELECT E'a\\' :no', :v", { v: 1 }, "SELECT E'a\\' :no', $1", [1]));
  test("extra keys are ignored", () => ok("SELECT :a", { a: 1, unused: 2 }, "SELECT $1", [1]));
});

describe("core.query", () => {
  test("named params: posts rewritten SQL and positional values", async () => {
    const { c, calls } = harness();
    const r = await c.query("SELECT * FROM users WHERE data->>'role' = :role", { role: "admin" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/@demo/query");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer tok");
    expect(calls[0]!.body).toEqual({ sql: "SELECT * FROM users WHERE data->>'role' = $1", params: ["admin"] });
    expect(r.data).toEqual([{ id: "u1" }]);
    expect(r.meta).toEqual({ rawQuery: { intent: "read", rowCount: 1 } });
  });
  test("10 list params sent unchanged", async () => {
    const { c, calls } = harness();
    await c.query("SELECT $1", ["x"]);
    expect(calls[0]!.body).toEqual({ sql: "SELECT $1", params: ["x"] });
  });
  test("11 no params: no params key", async () => {
    const { c, calls } = harness();
    await c.query("SELECT 1");
    expect(calls[0]!.body).toEqual({ sql: "SELECT 1" });
  });
  test("an empty list sends no params key", async () => {
    const { c, calls } = harness();
    await c.query("SELECT 1", []);
    expect(calls[0]!.body).toEqual({ sql: "SELECT 1" });
  });
  test("a bad list value throws before any request", async () => {
    const { c, calls } = harness();
    await expect(c.query("SELECT $1", [{} as never])).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    expect(calls.length).toBe(0);
  });
  test("a missing named value throws before any request", async () => {
    const { c, calls } = harness();
    await expect(c.query("SELECT :x", {})).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    expect(calls.length).toBe(0);
  });
  test("no projectSlug: K9O_MISSING_PROJECT_CONTEXT, no request", async () => {
    const { c, calls } = harness(undefined, null);
    await expect(c.query("SELECT 1")).rejects.toMatchObject({ code: "K9O_MISSING_PROJECT_CONTEXT" });
    expect(calls.length).toBe(0);
  });
  test("a gateway refusal surfaces as KError", async () => {
    const { c } = harness(() =>
      new Response(JSON.stringify({ code: "K9O_RAW_SQL_READ_ONLY", message: "read only", context: {} }), { status: 403 }),
    );
    const err = await c.query("DELETE FROM t").catch((e) => e);
    expect(err).toBeInstanceOf(KError);
    expect(err.code).toBe("K9O_RAW_SQL_READ_ONLY");
    expect(err.status).toBe(403);
  });
});

describe("select().textSearch / vectorSearch", () => {
  test("textSearch wire shape, defaults omitted", async () => {
    const { c, calls } = harness();
    await c.from("articles").select().textSearch("body", "climate resilience").limit(5);
    const q = calls[0]!.url.searchParams;
    expect(q.get("textSearch")).toBe("body:climate resilience");
    expect(q.get("textSearchLanguage")).toBeNull();
    expect(q.get("textSearchType")).toBeNull();
    expect(q.get("limit")).toBe("5");
  });
  test("textSearch language and type", async () => {
    const { c, calls } = harness();
    await c.from("articles").select().textSearch("body", "a b", { language: "french", type: "websearch" });
    const q = calls[0]!.url.searchParams;
    expect(q.get("textSearchLanguage")).toBe("french");
    expect(q.get("textSearchType")).toBe("websearch");
  });
  test("vectorSearch POSTs the embedding in a body", async () => {
    const { c, calls } = harness();
    await c.from("articles").select().vectorSearch("embedding", [0.1, 0.2]);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/@demo/data/articles/search");
    expect(calls[0]!.url.search).toBe("");
    expect(calls[0]!.body).toEqual({ vectorSearch: { column: "embedding", vector: [0.1, 0.2] } });
  });
  test("vectorSearch with filters, order, select and limit", async () => {
    const { c, calls } = harness();
    await c.from("articles").select().vectorSearch("embedding", [1, 2]).eq("status", "open").gt("score", 5).limit(20).count("exact");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({
      vectorSearch: { column: "embedding", vector: [1, 2] },
      filter: { status: "eq.open", score: "gt.5" },
      limit: 20,
      count: "exact",
    });
  });
  test("vectorSearch metric and vectorLimit", async () => {
    const { c, calls } = harness();
    await c.from("articles").select().vectorSearch("embedding", [1], { metric: "dot", limit: 10 });
    expect(calls[0]!.body).toEqual({ vectorSearch: { column: "embedding", vector: [1], metric: "dot", limit: 10 } });
  });
  test("vectorSearch with textSearch is rejected without a request", async () => {
    const { c, calls } = harness();
    let err: unknown;
    try {
      await c.from("articles").select().textSearch("body", "x").vectorSearch("embedding", [1]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KError);
    expect((err as KError).code).toBe("K9O_INVALID_FIELD_VALUE");
    expect(calls.length).toBe(0);
  });
  test("a select without vectorSearch is still a GET", async () => {
    const { c, calls } = harness();
    await c.from("articles").select().eq("status", "open");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.pathname).toBe("/@demo/data/articles");
  });
  test("the query text is URL-encoded", async () => {
    const { c, calls } = harness();
    await c.from("articles").select().textSearch("body", "a&b=c d");
    expect(calls[0]!.raw).toContain("textSearch=body%3Aa%26b%3Dc%20d");
    expect(calls[0]!.url.searchParams.get("textSearch")).toBe("body:a&b=c d");
  });
  test("validation errors throw K9O_INVALID_FIELD_VALUE", () => {
    const { c } = harness();
    const s = c.from("articles").select();
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as KError).code;
      }
      return "none";
    };
    expect(code(() => s.textSearch("bad col", "x"))).toBe("K9O_INVALID_FIELD_VALUE");
    expect(code(() => s.textSearch("1col", "x"))).toBe("K9O_INVALID_FIELD_VALUE");
    expect(code(() => s.textSearch("body", ""))).toBe("K9O_INVALID_FIELD_VALUE");
    expect(code(() => s.textSearch("body", "x", { language: "en glish" }))).toBe("K9O_INVALID_FIELD_VALUE");
    expect(code(() => s.textSearch("body", "x", { type: "fuzzy" as never }))).toBe("K9O_INVALID_FIELD_VALUE");
    expect(code(() => s.vectorSearch("embedding", []))).toBe("K9O_INVALID_FIELD_VALUE");
    expect(code(() => s.vectorSearch("embedding", [Number.NaN]))).toBe("K9O_INVALID_FIELD_VALUE");
    expect(code(() => s.vectorSearch("embedding", ["1" as never]))).toBe("K9O_INVALID_FIELD_VALUE");
    expect(code(() => s.vectorSearch("embedding", [1], { limit: 1001 }))).toBe("K9O_INVALID_FIELD_VALUE");
    expect(code(() => s.vectorSearch("embedding", [1], { limit: 0 }))).toBe("K9O_INVALID_FIELD_VALUE");
    expect(code(() => s.vectorSearch("embedding", [1], { metric: "x" as never }))).toBe("K9O_INVALID_FIELD_VALUE");
    expect(code(() => s.vectorSearch("bad col", [1]))).toBe("K9O_INVALID_FIELD_VALUE");
    expect(code(() => s.vectorSearch("embedding", [1], { limit: 1000 }))).toBe("none");
  });
});

describe("core.search", () => {
  test("full-text over one column, paged", async () => {
    const { c, calls } = harness();
    const r = await c.search("articles", { column: "body", q: "climate resilience", language: "french", type: "phrase", limit: 5, cursor: "cur_1" });
    const q = calls[0]!.url.searchParams;
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.pathname).toBe("/@demo/data/articles");
    expect(q.get("textSearch")).toBe("body:climate resilience");
    expect(q.get("textSearchLanguage")).toBe("french");
    expect(q.get("textSearchType")).toBe("phrase");
    expect(q.get("limit")).toBe("5");
    expect(q.get("cursor")).toBe("cur_1");
    expect(r.data).toEqual([{ id: "u1" }]);
  });
  test("a bad column throws before any request", async () => {
    const { c, calls } = harness();
    await expect(c.search("articles", { column: "bad col", q: "x" })).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    expect(calls.length).toBe(0);
  });
});
