import { describe, expect, test } from "bun:test";
import { KError, type RealtimeEvent } from "../src";
import { harness, json } from "./harness";

const BASE = "https://acme.api-de01.k9o.io/@demo/realtime";
const ok = (data: unknown = {}, status = 200) => json({ data, meta: {} }, status);

function sse(text: string, streaming = true): Response {
  if (!streaming) return { status: 200, body: null, text: async () => text, json: async () => ({}) } as unknown as Response;
  const stream = new ReadableStream<Uint8Array>({
    start(ctl) {
      ctl.enqueue(new TextEncoder().encode(text));
      ctl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function frame(n: number, payload: unknown = { n }): string {
  const ev = { topic: "collections.orders.*", eventType: "row_inserted", payload, occurredAt: "2026-11-13T10:00:00.000Z", eventId: `evt_${n}` };
  return `id: cur${n}\ndata: ${JSON.stringify(ev)}\n\n`;
}

describe("core.realtime.subscribe", () => {
  test("sends topic and JSON filter, then reconnects with Last-Event-ID and drops re-sent events", async () => {
    const { c, calls } = harness((_s, n) => (n === 1 ? sse(`retry: 5\n${frame(1)}${frame(2)}`) : sse(`retry: 5\n${frame(2)}${frame(3)}`)));
    const got: RealtimeEvent[] = [];
    for await (const e of c.realtime.subscribe("collections.orders.*", { filter: { status: "open" } })) {
      got.push(e);
      if (got.length === 3) break;
    }
    expect(got.map((e) => e.eventId)).toEqual(["evt_1", "evt_2", "evt_3"]);
    expect(got[0]!.eventType).toBe("row_inserted");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.pathname).toBe("/@demo/realtime/subscribe");
    expect(calls[0]!.url.searchParams.get("topic")).toBe("collections.orders.*");
    expect(JSON.parse(calls[0]!.url.searchParams.get("filter")!)).toEqual({ status: "open" });
    expect(calls[0]!.headers["accept"]).toBe("text/event-stream");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer tok");
    expect(calls[0]!.headers["last-event-id"]).toBeUndefined();
    expect(calls[1]!.headers["last-event-id"]).toBe("cur2");
  });

  test("no filter: the query has only topic", async () => {
    const { c, calls } = harness(() => sse(frame(1)));
    for await (const _ of c.realtime.subscribe("t.x")) break;
    expect(calls[0]!.raw).toBe(`${BASE}/subscribe?topic=t.x`);
  });

  test("a fetch without body streaming still delivers events", async () => {
    const { c } = harness(() => sse(`${frame(1)}${frame(2)}`, false));
    const got: string[] = [];
    for await (const e of c.realtime.subscribe("t.x")) {
      got.push(e.eventId);
      if (got.length === 2) break;
    }
    expect(got).toEqual(["evt_1", "evt_2"]);
  });

  test("a 4xx answer throws the gateway error; a 5xx is retried", async () => {
    const bad = harness(() => json({ code: "K9O_INVALID_FILTER", message: "bad filter", context: {} }, 400));
    await expect((async () => { for await (const _ of bad.c.realtime.subscribe("t.x")) break; })()).rejects.toMatchObject({ code: "K9O_INVALID_FILTER" });
    const flaky = harness((_s, n) => (n === 1 ? json({ code: "K9O_UPSTREAM_UNAVAILABLE", message: "down", context: {} }, 503) : sse(frame(1))));
    const got: string[] = [];
    for await (const e of flaky.c.realtime.subscribe("t.x", { retryDelayMs: 5 })) {
      got.push(e.eventId);
      break;
    }
    expect(got).toEqual(["evt_1"]);
    expect(flaky.calls).toHaveLength(2);
  });

  test("resync after events calls onResync and carries on with a fresh connection", async () => {
    const seen: string[] = [];
    const { c, calls } = harness((_s, n) =>
      n === 1 ? sse(`${frame(1)}event: resync\ndata: {"reason":"cursor-expired","action":"reread-source"}\n\n`) : sse(frame(2)),
    );
    const got: string[] = [];
    for await (const e of c.realtime.subscribe("t.x", { retryDelayMs: 5, onResync: (r) => { seen.push(`${r.reason}/${r.action}`); } })) {
      got.push(e.eventId);
      if (got.length === 2) break;
    }
    expect(seen).toEqual(["cursor-expired/reread-source"]);
    expect(got).toEqual(["evt_1", "evt_2"]);
    expect(calls[1]!.headers["last-event-id"]).toBeUndefined();
  });

  test("resync without onResync ends the subscription; a leading resync is only the head report", async () => {
    const a = harness(() => sse(`${frame(1)}event: resync\ndata: {}\n\n`));
    const got: string[] = [];
    for await (const e of a.c.realtime.subscribe("t.x")) got.push(e.eventId);
    expect(got).toEqual(["evt_1"]);
    const b = harness(() => sse(`event: resync\ndata: {}\n\n${frame(1)}`));
    for await (const e of b.c.realtime.subscribe("t.x")) {
      expect(e.eventId).toBe("evt_1");
      break;
    }
  });

  test("close() and an aborted signal end the loop", async () => {
    const stop = new AbortController();
    stop.abort();
    const { c, calls } = harness(() => sse(""));
    for await (const _ of c.realtime.subscribe("t.x", { signal: stop.signal })) throw new Error("unexpected");
    expect(calls).toHaveLength(0);
    const h = harness(() => sse(`retry: 60000\n${frame(1)}`));
    const sub = h.c.realtime.subscribe("t.x");
    const got: string[] = [];
    for await (const e of sub) {
      got.push(e.eventId);
      setTimeout(() => sub.close(), 10);
    }
    expect(got).toEqual(["evt_1"]);
  });

  test("no projectSlug or an invalid topic throws before any request", () => {
    const { c, calls } = harness(() => ok(), null);
    expect(() => c.realtime.subscribe("t.x")).toThrow(KError);
    const h = harness();
    expect(() => h.c.realtime.subscribe("")).toThrow(KError);
    expect(() => h.c.realtime.subscribe("x".repeat(201))).toThrow(KError);
    expect(calls.length + h.calls.length).toBe(0);
  });
});

describe("core.realtime.replay", () => {
  test("posts the topic and set options, and shapes the page", async () => {
    const { c, calls } = harness(() =>
      ok({
        topic: "audit.project.*",
        events: [
          { topic: "audit.project.x", eventType: "a.b", payload: { k: 1 }, occurredAt: "2026-11-13T10:00:00Z", sequence: "7", eventId: "evt_9" },
          { eventType: "a.c", payload: null, occurredAt: "2026-11-13T10:00:01Z", sequence: 8 },
          { nope: true },
        ],
        nextCursor: "8",
        hasMore: true,
      }),
    );
    const r = await c.realtime.replay("audit.project.*", { fromSequence: 0, untilSequence: "100", limit: 50, afterAuditEventId: "evt_abc123" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.raw).toBe(`${BASE}/replay`);
    expect(calls[0]!.body).toEqual({ topic: "audit.project.*", fromSequence: 0, untilSequence: "100", limit: 50, afterAuditEventId: "evt_abc123" });
    expect(r.data.events).toHaveLength(2);
    expect(r.data.events[0]).toEqual({ topic: "audit.project.x", eventType: "a.b", payload: { k: 1 }, occurredAt: "2026-11-13T10:00:00Z", sequence: "7", eventId: "evt_9" });
    expect(r.data.events[1]!.sequence).toBe("8");
    expect(r.data.events[1]!.eventId).toBeUndefined();
    expect(r.data.events[1]!.topic).toBe("audit.project.*");
    expect(r.data.nextCursor).toBe("8");
    expect(r.data.hasMore).toBe(true);
    expect(r.data.resync).toBeUndefined();
  });

  test("sends only the topic by default; a topic with no ledger answers resync", async () => {
    const { c, calls } = harness(() => ok({ topic: "collections.orders.*", events: [], nextCursor: null, hasMore: false, resync: "reread-source" }));
    const r = await c.realtime.replay("collections.orders.*");
    expect(calls[0]!.body).toEqual({ topic: "collections.orders.*" });
    expect(r.data).toEqual({ topic: "collections.orders.*", events: [], nextCursor: null, hasMore: false, resync: "reread-source" });
  });

  test("validates before sending", async () => {
    const { c, calls } = harness(() => ok());
    const bad: Array<[string, Record<string, unknown>]> = [
      ["", {}],
      ["x".repeat(201), {}],
      ["t", { fromSequence: -1 }],
      ["t", { fromSequence: 1.5 }],
      ["t", { untilSequence: "1a" }],
      ["t", { limit: 0 }],
      ["t", { limit: 10001 }],
      ["t", { limit: 2.5 }],
      ["t", { afterAuditEventId: "abc" }],
      ["t", { afterAuditEventId: "evt_" }],
      ["t", { afterAuditEventId: `evt_${"a".repeat(41)}` }],
    ];
    for (const [topic, o] of bad) {
      await expect(c.realtime.replay(topic, o)).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    }
    await c.realtime.replay("t", { limit: 10000, fromSequence: "0", afterAuditEventId: `evt_${"a".repeat(40)}` });
    expect(calls).toHaveLength(1);
  });

  test("no projectSlug: K9O_MISSING_PROJECT_CONTEXT; gateway errors arrive as KError", async () => {
    const none = harness(() => ok(), null);
    await expect(none.c.realtime.replay("t")).rejects.toMatchObject({ code: "K9O_MISSING_PROJECT_CONTEXT" });
    const denied = harness(() => json({ code: "K9O_RBAC_DENY", message: "no", context: {} }, 403));
    await expect(denied.c.realtime.replay("audit.project.*")).rejects.toMatchObject({ code: "K9O_RBAC_DENY" });
  });
});
