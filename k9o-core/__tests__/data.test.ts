import { describe, expect, test } from "bun:test";
import { harness, json } from "./harness";

describe("core.from select", () => {
  test("plain select GETs the collection", async () => {
    const { c, calls } = harness();
    const r = await c.from("notes").select();
    expect([calls[0]!.method, calls[0]!.url.pathname, calls[0]!.url.search]).toEqual(["GET", "/@demo/data/notes", ""]);
    expect(r.data).toEqual([{ id: "u1" }]);
  });

  test("every filter, limit, cursor and count land in the query string", async () => {
    const { c, calls } = harness();
    await c
      .from("notes")
      .select()
      .eq("a", "x")
      .neq("b", 1)
      .gt("c", 2)
      .gte("d", 3)
      .lt("e", 4)
      .lte("f", 5)
      .in("g", ["p", "q"])
      .notIn("h", [1, 2])
      .like("i", "ab%")
      .ilike("j", "AB%")
      .is("k", "null")
      .filter("l", "eq", true)
      .limit(20)
      .cursor("cur_9")
      .count("exact");
    const q = Object.fromEntries(calls[0]!.url.searchParams);
    expect(q).toEqual({
      a: "eq.x", b: "neq.1", c: "gt.2", d: "gte.3", e: "lt.4", f: "lte.5", g: "in.(p,q)", h: "notIn.(1,2)",
      i: "like.ab%", j: "ilike.AB%", k: "is.null", l: "eq.true", limit: "20", cursor: "cur_9", count: "exact",
    });
  });

  test("insert POSTs the record as JSON", async () => {
    const { c, calls } = harness(() => json({ data: { id: "r1", title: "t" }, meta: {} }, 201));
    const r = await c.from("notes").insert({ title: "t" });
    expect([calls[0]!.method, calls[0]!.url.pathname]).toEqual(["POST", "/@demo/data/notes"]);
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.body).toEqual({ title: "t" });
    expect(r.data).toEqual({ id: "r1", title: "t" });
  });

  test("update PATCHes /<id> with the patch", async () => {
    const { c, calls } = harness(() => json({ data: { id: "r 1" }, meta: {} }));
    await c.from("notes").update({ title: "n" }).eq("id", "r 1");
    expect([calls[0]!.method, calls[0]!.url.pathname]).toEqual(["PATCH", "/@demo/data/notes/r%201"]);
    expect(calls[0]!.body).toEqual({ title: "n" });
  });

  test("delete DELETEs /<id> with no body", async () => {
    const { c, calls } = harness(() => json({ data: { id: "r1" }, meta: {} }));
    await c.from("notes").delete().eq("id", "r1");
    expect([calls[0]!.method, calls[0]!.url.pathname]).toEqual(["DELETE", "/@demo/data/notes/r1"]);
    expect(calls[0]!.body).toBeUndefined();
  });

  test("update and delete without an id filter reject before any request", async () => {
    const { c, calls } = harness();
    await expect(Promise.resolve(c.from("notes").update({ a: 1 }).eq("status", "x"))).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    await expect(Promise.resolve(c.from("notes").delete())).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    expect(calls.length).toBe(0);
  });

  test("a bad collection name rejects before any request", async () => {
    const { c, calls } = harness();
    await expect(Promise.resolve(c.from("Bad Name").select())).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    await expect(Promise.resolve(c.from("../x").select())).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    expect(calls.length).toBe(0);
  });

  test("no projectSlug rejects with K9O_MISSING_PROJECT_CONTEXT", async () => {
    const { c, calls } = harness(undefined, null);
    await expect(Promise.resolve(c.from("notes").select())).rejects.toMatchObject({ code: "K9O_MISSING_PROJECT_CONTEXT" });
    expect(calls.length).toBe(0);
  });

  test("a gateway error becomes a KError; 204 resolves empty", async () => {
    const bad = harness(() => json({ code: "K9O_NOT_FOUND", message: "nope", context: {} }, 404));
    await expect(Promise.resolve(bad.c.from("notes").select())).rejects.toMatchObject({ code: "K9O_NOT_FOUND", status: 404 });
    const empty = harness(() => new Response(null, { status: 204 }));
    const r = await empty.c.from("notes").delete().eq("id", "r1");
    expect(r.data).toBeUndefined();
  });
});
