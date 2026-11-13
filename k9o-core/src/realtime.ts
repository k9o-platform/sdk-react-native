/**
 * Realtime: `core.realtime.*` (project plane, /@<slug>/realtime).
 *
 * - `subscribe(topic, options)`: GET /@<slug>/realtime/subscribe?topic=&filter=<json> over Server-Sent Events. It reconnects
 *   by itself with `Last-Event-ID`, yields each event once and calls `onResync` when the gateway cannot resume.
 * - `replay(topic, options)`: POST /@<slug>/realtime/replay, one page of the topic's ledger.
 *
 * `subscribe` needs a `fetch` that streams response bodies (for example Expo's `expo/fetch`); with a fetch that does not,
 * events arrive when the connection closes. `filter` narrows and access rules gate. Gateway codes such as
 * `K9O_INVALID_FILTER`, `K9O_SUBSCRIPTION_LIMIT_EXCEEDED` and `K9O_TIER_FEATURE_GATED` arrive as `KError`.
 */

import type { Envelope } from "./CoreClient";
import { KError } from "./KError";
import { parseSseFrames, type SseFrame } from "./sse";
import { invalidField, projectPath, type QueryString, type Transport } from "./transport";

/** A concrete topic string, for example `collections.orders.*`. */
export type RealtimeTopic = string;

/** A per-topic filter predicate, sent as JSON. */
export type RealtimeFilter = Record<string, unknown>;

/** One event on a subscription. */
export type RealtimeEvent<T = unknown> = {
  topic: RealtimeTopic;
  /** The event type within the topic (for example `row_inserted`). */
  eventType: string;
  payload: T;
  occurredAt: string;
  /** The event's id (`evt_...`), the same on every gateway replica. */
  eventId: string;
};

/** Why the gateway could not resume, from its `resync` frame. */
export type RealtimeResync = { reason: string; action: string };

export type RealtimeSubscribeOptions = {
  /** A per-topic filter, sent as `filter=<json>`. */
  filter?: RealtimeFilter | undefined;
  /** Abort to end the subscription. */
  signal?: AbortSignal | undefined;
  /**
   * Called when the gateway cannot resume the feed (a `resync` frame): events may have been missed, so read current state
   * again. The subscription then carries on live from a fresh connection. Without it, the subscription ends there.
   */
  onResync?: ((resync: RealtimeResync) => void | Promise<void>) | undefined;
  /** How many recent event ids to remember for dropping a resume's re-sent events. Default 1000. */
  dedupeMax?: number | undefined;
  /** How long to remember an event id, in milliseconds. Default 60000. */
  dedupeTtlMs?: number | undefined;
  /** Reconnect when no bytes arrive for this long, in milliseconds. Default 45000. */
  idleTimeoutMs?: number | undefined;
  /** Wait this long before reconnecting, in milliseconds. Default: the server's hint, else 1000; backs off to 30000 on repeated failures. */
  retryDelayMs?: number | undefined;
};

/** A live subscription: an async iterable of events with an explicit `close()`. */
export type RealtimeSubscription<T = unknown> = AsyncIterable<RealtimeEvent<T>> & {
  /** End the subscription and release the connection. */
  close(): void;
};

export type RealtimeReplayOptions = {
  /** Replay from this position in the topic's ledger. */
  fromSequence?: number | string | undefined;
  /** Stop at this position. */
  untilSequence?: number | string | undefined;
  /** Events per call, 1 to 10000. Without it the gateway chooses. */
  limit?: number | undefined;
  /** `audit.project.*` topics only: replay the events after this one (the last `eventId` you received). */
  afterAuditEventId?: string | undefined;
};

/** An event from `replay`: the realtime shape plus the ledger's `sequence`; `eventId` is optional. */
export type RealtimeReplayEvent<T = unknown> = Omit<RealtimeEvent<T>, "eventId"> & {
  eventId?: string | undefined;
  /** The event's position in the ledger, as a string. */
  sequence?: string | undefined;
};

export type RealtimeReplayPage<T = unknown> = {
  topic: string;
  events: RealtimeReplayEvent<T>[];
  /** Where the next call starts (the last event's `sequence`), or null when there is none. */
  nextCursor: string | number | null;
  /** True when more events follow this page. */
  hasMore: boolean;
  /** Set to `reread-source` when the topic keeps no ledger: read current state, then subscribe. */
  resync?: string | undefined;
};

const REPLAY_MAX = 10_000;
const DEFAULT_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** The ids of recently yielded events, bounded by count and age, so the events a resume re-sends are dropped. */
class SeenEventIds {
  private readonly seen = new Map<string, number>();
  constructor(private readonly max = 1000, private readonly ttlMs = 60_000) {}
  firstTime(id: string): boolean {
    const t = Date.now();
    for (const [k, at] of this.seen) {
      if (t - at <= this.ttlMs && this.seen.size <= this.max) break;
      this.seen.delete(k);
    }
    if (this.seen.has(id)) return false;
    this.seen.set(id, t);
    if (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value as string);
    return true;
  }
}

function resyncInfo(frame: SseFrame): RealtimeResync {
  let parsed: unknown = null;
  try {
    parsed = frame.data === null ? null : JSON.parse(frame.data);
  } catch {
    /* keep the defaults */
  }
  const o = isObj(parsed) ? parsed : {};
  return {
    reason: typeof o["reason"] === "string" ? o["reason"] : "cursor-unknown",
    action: typeof o["action"] === "string" ? o["action"] : "reread-source",
  };
}

/**
 * The tail loop. When a connection ends (the gateway bounds each one, the network drops, or it goes quiet) the next opens
 * after a delay with `Last-Event-ID` set to the last cursor received; events already delivered are dropped by `eventId`.
 * A `resync` frame on a fresh connection before any data only reports the head of the stream and is skipped; any other
 * calls `onResync` and carries on live, or ends the subscription when there is no callback. A 4xx answer throws; a 5xx or a
 * network error is retried.
 */
async function* tail<T>(
  t: Transport,
  path: string,
  query: QueryString,
  options: RealtimeSubscribeOptions,
  stop: AbortSignal,
): AsyncGenerator<RealtimeEvent<T>, void, void> {
  const idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const baseRetry = options.retryDelayMs;
  let lastEventId: string | undefined;
  let seen = new SeenEventIds(options.dedupeMax, options.dedupeTtlMs);
  let serverRetry = DEFAULT_RECONNECT_MS;
  let failures = 0;

  while (!stop.aborted) {
    const conn = new AbortController();
    const onStop = () => conn.abort();
    stop.addEventListener("abort", onStop, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => conn.abort(), idleMs);
    };
    let gotFrame = false;
    let resynced = false;
    let sawData = false;
    try {
      bump();
      let response: Response | undefined;
      try {
        response = await t.stream(path, {
          query,
          signal: conn.signal,
          ...(lastEventId !== undefined ? { headers: { "last-event-id": lastEventId } } : {}),
        });
      } catch (e) {
        if (stop.aborted) return;
        // A client error will not get better by asking again.
        if (e instanceof KError && e.status !== null && e.status >= 400 && e.status < 500) throw e;
        response = undefined;
      }
      if (response !== undefined) {
        try {
          for await (const frame of parseSseFrames(response, { onChunk: bump })) {
            if (stop.aborted) return;
            if (frame.retry !== undefined) serverRetry = Math.min(frame.retry, MAX_RECONNECT_MS);
            if (frame.event === "resync") {
              gotFrame = true;
              failures = 0;
              if (lastEventId === undefined && !sawData) continue; // only reports the head of the stream
              resynced = true;
              lastEventId = undefined;
              seen = new SeenEventIds(options.dedupeMax, options.dedupeTtlMs);
              if (options.onResync === undefined) return;
              await options.onResync(resyncInfo(frame));
              break;
            }
            if (frame.data === null) continue;
            sawData = true;
            let parsed: unknown;
            try {
              parsed = JSON.parse(frame.data);
            } catch {
              continue;
            }
            if (!isObj(parsed) || typeof parsed["eventType"] !== "string") continue;
            const wireId = parsed["eventId"];
            const eventId = typeof wireId === "string" ? wireId : (frame.id ?? "");
            gotFrame = true;
            failures = 0;
            const cursor = frame.id !== undefined && frame.id !== "" ? frame.id : eventId;
            if (cursor !== "") lastEventId = cursor;
            if (eventId !== "" && !seen.firstTime(eventId)) continue;
            yield { ...parsed, eventId } as RealtimeEvent<T>;
          }
        } catch (e) {
          if (stop.aborted) return;
          // A callback that throws is the caller's error; a broken connection is treated like the server closing it.
          if (resynced) throw e;
        }
      }
    } finally {
      clearTimeout(idle);
      stop.removeEventListener("abort", onStop);
      conn.abort();
    }
    if (stop.aborted) return;
    if (!gotFrame) failures += 1;
    const base = baseRetry ?? serverRetry;
    const wait = resynced || failures === 0 ? base : Math.min(base * 2 ** (failures - 1), MAX_RECONNECT_MS);
    await sleep(wait, stop);
  }
}

function checkSequence(name: string, v: number | string | undefined): void {
  if (v === undefined) return;
  const ok = typeof v === "number" ? Number.isSafeInteger(v) && v >= 0 : typeof v === "string" && /^[0-9]+$/.test(v);
  if (!ok) {
    throw invalidField(`realtime.replay: ${name} must be a non-negative integer`, { field: name }, `Pass ${name} as a whole number or a string of digits.`);
  }
}

function checkTopic(op: string, topic: unknown): void {
  if (typeof topic !== "string" || topic.length === 0 || topic.length > 200) {
    throw invalidField(`${op}: topic must be a non-empty string of at most 200 characters`, { field: "topic" });
  }
}

function replayPageFrom<T>(data: unknown, topic: string): RealtimeReplayPage<T> {
  const o = isObj(data) ? data : {};
  const events: RealtimeReplayEvent<T>[] = [];
  for (const item of Array.isArray(o["events"]) ? o["events"] : []) {
    if (!isObj(item) || typeof item["eventType"] !== "string") continue;
    const ev: RealtimeReplayEvent<T> = {
      topic: typeof item["topic"] === "string" ? item["topic"] : topic,
      eventType: item["eventType"],
      payload: item["payload"] as T,
      occurredAt: typeof item["occurredAt"] === "string" ? item["occurredAt"] : "",
    };
    if (typeof item["eventId"] === "string" && item["eventId"] !== "") ev.eventId = item["eventId"];
    const seq = item["sequence"];
    if (typeof seq === "string") ev.sequence = seq;
    else if (typeof seq === "number") ev.sequence = String(seq);
    events.push(ev);
  }
  const cursor = o["nextCursor"];
  const page: RealtimeReplayPage<T> = {
    topic: typeof o["topic"] === "string" ? o["topic"] : topic,
    events,
    nextCursor: typeof cursor === "string" || typeof cursor === "number" ? cursor : null,
    hasMore: o["hasMore"] === true,
  };
  if (typeof o["resync"] === "string") page.resync = o["resync"];
  return page;
}

export type RealtimeNamespace = ReturnType<typeof makeRealtimeNamespace>;

export function makeRealtimeNamespace(t: Transport) {
  return {
    /**
     * Subscribe to a topic. Returns an async iterable of events over SSE; it reconnects and resumes by itself, yields each
     * event once, and ends when `signal` aborts or `close()` is called. Pass `onResync` to read current state again when the
     * gateway cannot resume; without it the loop ends there.
     *
     * ```ts
     * const sub = client.realtime.subscribe("collections.orders.*", { filter: { status: "open" } });
     * for await (const event of sub) console.log(event.eventType, event.payload);
     * ```
     */
    subscribe<T = unknown>(topic: RealtimeTopic, options: RealtimeSubscribeOptions = {}): RealtimeSubscription<T> {
      const path = projectPath(t, "realtime operations", "realtime/subscribe");
      checkTopic("realtime.subscribe", topic);
      const query: QueryString = { topic };
      if (options.filter) query.filter = JSON.stringify(options.filter);
      const own = new AbortController();
      const outer = options.signal;
      if (outer?.aborted) own.abort();
      else outer?.addEventListener("abort", () => own.abort(), { once: true });
      return {
        [Symbol.asyncIterator]() {
          const it = tail<T>(t, path, query, options, own.signal);
          return {
            next: () => it.next(),
            return: async () => {
              own.abort();
              await it.return(undefined);
              return { done: true, value: undefined } as IteratorResult<RealtimeEvent<T>>;
            },
            throw: async (err) => {
              own.abort();
              await it.return(undefined);
              throw err;
            },
          };
        },
        close() {
          own.abort();
        },
      };
    },

    /**
     * One page of the topic's ledger (`POST /@<slug>/realtime/replay`). Page on with `fromSequence` while `hasMore` is true.
     * Only `audit.project.*` topics keep a ledger; for the others the answer has no events and `resync: "reread-source"`:
     * read current state, then `subscribe`.
     *
     * ```ts
     * const { data: page } = await client.realtime.replay("audit.project.*", { fromSequence: 0, limit: 100 });
     * ```
     */
    async replay<T = unknown>(topic: RealtimeTopic, options: RealtimeReplayOptions = {}): Promise<Envelope<RealtimeReplayPage<T>>> {
      const path = projectPath(t, "realtime operations", "realtime/replay");
      checkTopic("realtime.replay", topic);
      checkSequence("fromSequence", options.fromSequence);
      checkSequence("untilSequence", options.untilSequence);
      if (options.afterAuditEventId !== undefined && !/^evt_[0-9A-Za-z]{1,40}$/.test(options.afterAuditEventId)) {
        throw invalidField("realtime.replay: afterAuditEventId must look like evt_ followed by letters and digits", { field: "afterAuditEventId" });
      }
      if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > REPLAY_MAX)) {
        throw invalidField("realtime.replay: limit must be an integer from 1 to 10000", { field: "limit" }, "Pass a limit from 1 to 10000, or leave it out.");
      }
      const body: Record<string, unknown> = { topic };
      if (options.fromSequence !== undefined) body["fromSequence"] = options.fromSequence;
      if (options.untilSequence !== undefined) body["untilSequence"] = options.untilSequence;
      if (options.limit !== undefined) body["limit"] = options.limit;
      if (options.afterAuditEventId !== undefined) body["afterAuditEventId"] = options.afterAuditEventId;
      const res = await t.request<unknown>("POST", path, { body });
      return { data: replayPageFrom<T>(res.data, topic), meta: res.meta };
    },
  };
}
