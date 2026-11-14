/** Closed-taxonomy error for core client operations. Wire shape is FLAT: {code, message, context, recommendation}. */

export interface KErrorWire {
  code: string;
  message: string;
  context?: Record<string, unknown>;
  /** A string, null, or an object such as `{ action }` or `{ retryAfterSec, note }`. */
  recommendation?: unknown;
  requestId?: string;
}

export class KError extends Error {
  readonly code: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly recommendation: string | null;
  readonly status: number | null;
  readonly requestId: string | null;
  /** Seconds the gateway asks you to wait before retrying, or null. */
  readonly retryAfterSec: number | null;

  constructor(init: {
    code: string;
    message: string;
    context?: Record<string, unknown> | undefined;
    recommendation?: string | null | undefined;
    status?: number | null | undefined;
    requestId?: string | null | undefined;
    retryAfterSec?: number | null | undefined;
    cause?: unknown;
  }) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "KError";
    this.code = init.code;
    this.context = Object.freeze({ ...(init.context ?? {}) });
    this.recommendation = init.recommendation ?? null;
    this.status = init.status ?? null;
    this.requestId = init.requestId ?? null;
    this.retryAfterSec = init.retryAfterSec ?? null;
  }
}

/** Reads the wire `recommendation` (null, a string, or an object) into its text and the wait the gateway asks for. */
export function readRecommendation(value: unknown): { recommendation: string | null; retryAfterSec: number | null } {
  if (typeof value === "string") return { recommendation: value, retryAfterSec: null };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { recommendation: null, retryAfterSec: null };
  const o = value as Record<string, unknown>;
  const text = typeof o.action === "string" ? o.action : typeof o.note === "string" ? o.note : null;
  const w = o.retryAfterSec;
  return { recommendation: text, retryAfterSec: typeof w === "number" && Number.isFinite(w) && w >= 0 ? w : null };
}
