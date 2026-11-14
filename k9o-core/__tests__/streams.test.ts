import { describe, expect, test } from "bun:test";
import { KError, type StreamEvent } from "../src";
import { harness, json } from "./harness";

const BASE = "https://acme.api-de01.k9o.io/@demo/data-streams/user";
const ok = (data: unknown = {}, status = 200) => json({ data, meta: {} }, status);

function sse(text: string, streaming = true): Response {
  if (!streaming) {
    // A fetch that cannot stream: no readable body, only text().
    return { status: 200, body: null, text: async () => text, json: async () => ({}) } as unknown as Response;
  }
  const stream = new ReadableStream<Uint8Array>({
    start(ctl) {
      ctl.enqueue(new TextEncoder().encode(text));
      ctl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function frame(seq: number, data: unknown): string {
  const ev = { sequence: String(seq), subject: "k9o.x.user.pstr_1._", data, publishedAt: "2026-10-26T10:00:00.000Z" };
  return `id: ${seq}\ndata: ${JSON.stringify(ev)}\n\n`;
}

describe("core.streams control plane", () => {
  test("create, list, get, delete use the user stream routes", async () => {
    const { c, calls } = harness(() => ok());
    await c.streams.create({ displayName: "Orders", maxBytes: 1073741824 });
    await c.streams.list();
    await c.streams.get("orders");
    await c.streams.delete("orders");
    expect(calls.map((s) => `${s.method} ${s.raw}`)).toEqual([`POST ${BASE}`, `GET ${BASE}`, `GET ${BASE}/orders`, `DELETE ${BASE}/orders`]);
    expect(calls[0]!.body).toEqual({ displayName: "Orders", maxBytes: 1073741824 });
  });

  test("no projectSlug: K9O_MISSING_PROJECT_CONTEXT, also for subscribe", async () => {
    const { c, calls } = harness(() => ok(), null);
    await expect(c.streams.list()).rejects.toMatchObject({ code: "K9O_MISSING_PROJECT_CONTEXT" });
    expect(() => c.streams.subscribe("orders")).toThrow(KError);
    expect(calls.length).toBe(0);
  });
});

describe("core.streams.publish", () => {
  test("sends { data, subject } exactly", async () => {
    const { c, calls } = harness(() => ok({ streamSlug: "orders", subject: "s", bytes: 8, accepted: true }, 202));
    const r = await c.streams.publish("orders", { id: 1 }, { subject: "eu.new" });
    expect(calls[0]!.raw).toBe(`${BASE}/orders/publish`);
    expect(calls[0]!.body).toEqual({ data: { id: 1 }, subject: "eu.new" });
    expect(r.data.accepted).toBe(true);
  });

  test("omits subject when not given and keeps falsy data", async () => {
    const { c, calls } = harness(() => ok({}, 202));
    await c.streams.publish("orders", 0);
    await c.streams.publish("orders", undefined);
    expect(calls[0]!.body).toEqual({ data: 0 });
    expect(calls[1]!.body).toEqual({ data: null });
  });

  test("maps 503 K9O_STREAM_UNAVAILABLE to a typed KError", async () => {
    const { c } = harness(() => json({ code: "K9O_STREAM_UNAVAILABLE", message: "The stream data plane is not yet available.", context: {} }, 503));
    const err = await c.streams.publish("orders", {}).catch((e) => e);
    expect(err).toBeInstanceOf(KError);
    expect(err.code).toBe("K9O_STREAM_UNAVAILABLE");
    expect(err.status).toBe(503);
  });
});

describe("core.streams.replay", () => {
  test("sends only the given range fields", async () => {
    const { c, calls } = harness(() => ok({ streamSlug: "orders", events: [], nextCursor: null, hasMore: false }));
    await c.streams.replay("orders", { fromSequence: 10, untilSequence: "50", limit: 25 });
    await c.streams.replay("orders");
    expect(calls[0]!.raw).toBe(`${BASE}/orders/replay`);
    expect(calls[0]!.body).toEqual({ fromSequence: 10, untilSequence: "50", limit: 25 });
    expect(calls[1]!.body).toEqual({});
  });
});

describe("core.streams.subscribe", () => {
  test("reconnects from the last sequence when the server closes the connection", async () => {
    const { c, calls } = harness((_s, n) =>
      n === 1 ? sse(`retry: 5\n:ok\n\n${frame(1, { a: 1 })}${frame(2, { a: 2 })}`) : sse(`retry: 5\n:ok\n\n${frame(3, { a: 3 })}`),
    );
    const got: StreamEvent[] = [];
    for await (const e of c.streams.subscribe("orders", { fromSequence: 0 })) {
      got.push(e);
      if (got.length === 3) break;
    }
    expect(got.map((e) => e.sequence)).toEqual(["1", "2", "3"]);
    expect(got[2]!.data).toEqual({ a: 3 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.raw).toBe(`${BASE}/orders/subscribe?fromSequence=0`);
    expect(calls[1]!.raw).toBe(`${BASE}/orders/subscribe?fromSequence=2`);
    expect(calls[0]!.headers["accept"]).toBe("text/event-stream");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer tok");
  });

  test("starts without fromSequence when none is given", async () => {
    const { c, calls } = harness(() => sse(frame(1, "x")));
    for await (const _ of c.streams.subscribe("orders")) break;
    expect(calls[0]!.raw).toBe(`${BASE}/orders/subscribe`);
  });

  test("a fetch without body streaming still delivers events (on connection close)", async () => {
    const { c } = harness(() => sse(`${frame(1, "x")}${frame(2, "y")}`, false));
    const got: string[] = [];
    for await (const e of c.streams.subscribe("orders")) {
      got.push(e.sequence);
      if (got.length === 2) break;
    }
    expect(got).toEqual(["1", "2"]);
  });

  test("ends when the signal aborts while waiting to reconnect", async () => {
    const stop = new AbortController();
    const { c, calls } = harness(() => sse(`retry: 60000\n${frame(1, "x")}`));
    const got: string[] = [];
    for await (const e of c.streams.subscribe("orders", { signal: stop.signal })) {
      got.push(e.sequence);
      setTimeout(() => stop.abort(), 10);
    }
    expect(got).toEqual(["1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal).toBeTruthy();
  });

  test("ends when the signal is already aborted, without a request", async () => {
    const stop = new AbortController();
    stop.abort();
    const { c, calls } = harness(() => sse(""));
    for await (const _ of c.streams.subscribe("orders", { signal: stop.signal })) throw new Error("unexpected event");
    expect(calls).toHaveLength(0);
  });

  test("close() ends the iteration", async () => {
    const { c } = harness(() => sse(`retry: 60000\n${frame(1, "x")}`));
    const sub = c.streams.subscribe("orders");
    const got: string[] = [];
    for await (const e of sub) {
      got.push(e.sequence);
      sub.close();
    }
    expect(got).toEqual(["1"]);
  });

  test("surfaces 503 on open as a KError", async () => {
    const { c } = harness(() => json({ code: "K9O_STREAM_UNAVAILABLE", message: "unavailable", context: {} }, 503));
    const err = await (async () => {
      for await (const _ of c.streams.subscribe("orders")) return null;
      return null;
    })().catch((e) => e);
    expect(err).toBeInstanceOf(KError);
    expect(err.code).toBe("K9O_STREAM_UNAVAILABLE");
  });
});
