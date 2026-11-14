/**
 * Closed error taxonomy for @k9o/gate-react-native SDK operations.
 * Maps the gateway KError wire codes to a typed error class hierarchy.
 *
 * A `K9O_*` wire code this client does not type is kept as `code` (for example `K9O_MAGIC_LINK_REDIRECT_NOT_CONFIGURED`),
 * unless the client was built with `errors: "redacted"`, which reduces it to `UNKNOWN`.
 */

export type GateErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "INVALID_CREDENTIALS"
  | "GATE_REGION_UNAVAILABLE"
  | "RATE_LIMITED"
  | "K9O_INVALID_BASE_URL"
  | "K9O_INVALID_FIELD_VALUE"
  | "NETWORK"
  | "DECODING"
  | "UNKNOWN";

/** Why the gateway ended a session, from `K9O_SESSION_EXPIRED`'s `context.reason`. */
export type SessionEndReason = "inactive" | "max_length" | "revoked" | "replay";
const SESSION_END_REASONS: readonly string[] = ["inactive", "max_length", "revoked", "replay"];

/** `full` (default) keeps everything the gateway said; `redacted` keeps only what an app needs to show or to wait. */
export type ErrorsMode = "full" | "redacted";

/** Fields a gateway answer or the transport can add to an error. Every field is optional. */
export interface GateErrorDetails {
  statusCode?: number | undefined;
  body?: string | undefined;
  cause?: unknown;
  context?: Record<string, unknown> | undefined;
  requestId?: string | null | undefined;
  recommendation?: string | null | undefined;
  retryAfterSec?: number | null | undefined;
  publicMessage?: string | undefined;
  errors?: ErrorsMode | undefined;
  sessionEndReason?: SessionEndReason | null | undefined;
}

/** Fixed sentences for app users, chosen by status class only. Same text in every language. */
const PUBLIC = {
  auth: "You are not signed in or not allowed to do this.",
  notFound: "Not found.",
  tooMany: "Too many attempts. Try again later.",
  server: "Something went wrong. Try again later.",
  network: "Could not reach the service.",
  other: "The request could not be completed.",
} as const;

const MESSAGE = {
  unauthenticated: "Session expired or not authenticated.",
  forbidden: "Access forbidden for the current session.",
  invalidCredentials: "Invalid credentials.",
  rateLimited: "Too many requests. Try again shortly.",
  regionUnavailable: "The region is unavailable. Try again shortly.",
} as const;

function publicMessageForStatus(status: number | undefined): string {
  if (status === 401 || status === 403) return PUBLIC.auth;
  if (status === 404) return PUBLIC.notFound;
  if (status === 429) return PUBLIC.tooMany;
  if (status !== undefined && status >= 500 && status <= 599) return PUBLIC.server;
  return PUBLIC.other;
}

export class GateError extends Error {
  readonly code: GateErrorCode | (string & {});
  readonly statusCode?: number | undefined;
  readonly body?: string | undefined;
  /** Structured detail for configuration errors, such as `{ field: "baseUrl" }`; the gateway's `context` otherwise. Empty when redacted. */
  readonly context: Readonly<Record<string, unknown>>;
  /** A fixed sentence an app shows to its users. Never built from gateway text. */
  readonly publicMessage: string;
  /** The `x-k9o-request-id` response header, or null when none was read. */
  readonly requestId: string | null;
  /** Set when the gateway ended the session (`K9O_SESSION_EXPIRED`): `inactive`, `max_length`, `revoked` or `replay`. Kept when redacted. The user must sign in again. */
  readonly sessionEndReason: SessionEndReason | null;
  /** The gateway's advice as text (its `action`, else `note`), or null. For logs. Null when redacted. */
  readonly recommendation: string | null;
  /** Seconds the gateway asked the caller to wait, from the body or the `Retry-After` header; null when none. */
  readonly retryAfterSec: number | null;

  private constructor(code: GateErrorCode | (string & {}), message: string, d: GateErrorDetails = {}) {
    const redacted = d.errors === "redacted";
    const publicMessage = d.publicMessage ?? publicMessageForStatus(d.statusCode);
    super(redacted ? publicMessage : message, d.cause ? { cause: d.cause } : undefined);
    this.name = "GateError";
    this.code = code;
    this.statusCode = d.statusCode;
    this.body = redacted ? undefined : d.body;
    this.context = Object.freeze({ ...(redacted ? {} : (d.context ?? {})) });
    this.publicMessage = publicMessage;
    this.requestId = d.requestId ?? null;
    this.sessionEndReason = d.sessionEndReason ?? null;
    this.recommendation = redacted ? null : (d.recommendation ?? null);
    this.retryAfterSec = d.retryAfterSec ?? null;
  }

  static unauthenticated(d: GateErrorDetails = {}): GateError {
    return new GateError("UNAUTHENTICATED", MESSAGE.unauthenticated, { ...d, publicMessage: d.publicMessage ?? PUBLIC.auth });
  }

  static forbidden(d: GateErrorDetails = {}): GateError {
    return new GateError("FORBIDDEN", MESSAGE.forbidden, { ...d, publicMessage: d.publicMessage ?? PUBLIC.auth });
  }

  static invalidCredentials(d: GateErrorDetails = {}): GateError {
    return new GateError("INVALID_CREDENTIALS", MESSAGE.invalidCredentials, { ...d, publicMessage: d.publicMessage ?? PUBLIC.auth });
  }

  /** The step that finds the email's region is rate-limited (429). Safe to retry. */
  static rateLimited(statusCode: number, body?: string, d: GateErrorDetails = {}): GateError {
    return new GateError("RATE_LIMITED", MESSAGE.rateLimited, {
      ...d,
      statusCode,
      body,
      publicMessage: d.publicMessage ?? publicMessageForStatus(statusCode),
    });
  }

  /** The region that holds the email is unavailable (503). Safe to retry after the hint in `body`. */
  static regionUnavailable(statusCode: number, body?: string, d: GateErrorDetails = {}): GateError {
    return new GateError("GATE_REGION_UNAVAILABLE", MESSAGE.regionUnavailable, {
      ...d,
      statusCode,
      body,
      publicMessage: d.publicMessage ?? publicMessageForStatus(statusCode),
    });
  }

  /** Neither `orgBaseUrl` nor `orgSlug` was given. */
  static invalidBaseUrl(): GateError {
    return new GateError("K9O_INVALID_BASE_URL", "Pass orgBaseUrl (for example https://acme.api.k9o.io) or orgSlug.", {
      context: { field: "baseUrl" },
      publicMessage: PUBLIC.other,
    });
  }

  /** A value does not match its required format. */
  static invalidFieldValue(field: string, value: string): GateError {
    return new GateError(
      "K9O_INVALID_FIELD_VALUE",
      `${field} "${value}" does not match required format ^[a-z][a-z0-9-]{1,62}$ (must not end with '-').`,
      { context: { field, slug: value }, publicMessage: PUBLIC.other }
    );
  }

  /** The `errors` option is neither `"full"` nor `"redacted"`. */
  static invalidErrorsMode(value: unknown): GateError {
    return new GateError("K9O_INVALID_FIELD_VALUE", `errors "${String(value)}" must be "full" or "redacted".`, {
      context: { field: "errors", value },
      publicMessage: PUBLIC.other,
    });
  }

  static network(cause: unknown, d: GateErrorDetails = {}): GateError {
    return new GateError(
      "NETWORK",
      `Network error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { ...d, cause, publicMessage: d.publicMessage ?? PUBLIC.network }
    );
  }

  static decoding(cause: unknown, d: GateErrorDetails = {}): GateError {
    return new GateError(
      "DECODING",
      `Response decoding error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { ...d, cause, publicMessage: d.publicMessage ?? PUBLIC.other }
    );
  }

  static unknown(statusCode: number, body?: string, d: GateErrorDetails = {}): GateError {
    return new GateError("UNKNOWN", `Unexpected error (HTTP ${statusCode}): ${body ?? "<no body>"}`, {
      ...d,
      statusCode,
      body,
      publicMessage: d.publicMessage ?? publicMessageForStatus(statusCode),
    });
  }

  /**
   * @internal Maps a non-2xx gateway answer to a GateError. Called by `gateErrorFromResponse`; not part of the public API.
   */
  static fromResponse(statusCode: number, body: string | undefined, meta: ResponseMeta = {}): GateError {
    const errors = meta.errors ?? "full";
    const wire = parseWire(body);
    const base: GateErrorDetails = {
      statusCode,
      requestId: meta.requestId ?? null,
      publicMessage: publicMessageForStatus(statusCode),
      errors,
      context: wire.context,
      recommendation: wire.recommendation,
      retryAfterSec: wire.retryAfterSec ?? retryAfterFromHeader(meta.retryAfter),
    };
    switch (wire.code.replace(/^K9O_/, "")) {
      case "SESSION_EXPIRED": {
        const reason = wire.context["reason"];
        const known = typeof reason === "string" && SESSION_END_REASONS.includes(reason);
        return GateError.unauthenticated({ ...base, sessionEndReason: known ? (reason as SessionEndReason) : null });
      }
      case "UNAUTHENTICATED":
      case "MISSING_TOKEN":
        return GateError.unauthenticated(base);
      case "FORBIDDEN":
        return GateError.forbidden(base);
      case "INVALID_CREDENTIALS":
        return GateError.invalidCredentials(base);
      case "RATE_LIMITED":
        return GateError.rateLimited(statusCode, body, base);
      case "GATE_REGION_UNAVAILABLE":
        return GateError.regionUnavailable(statusCode, body, base);
    }
    // Not a code this client types. A platform-namespaced code keeps its wire name in full mode.
    const keepsWireCode = wire.code.startsWith("K9O_") && errors === "full";
    return new GateError(keepsWireCode ? wire.code : "UNKNOWN", `Unexpected error (HTTP ${statusCode}): ${body ?? "<no body>"}`, {
      ...base,
      body,
    });
  }
}

/** What the transport read from a response, passed to `gateErrorFromResponse`. */
export interface ResponseMeta {
  /** The `x-k9o-request-id` header, or null. */
  requestId?: string | null;
  /** The raw `Retry-After` header, or null. Read as seconds. */
  retryAfter?: string | null;
  errors?: ErrorsMode;
}

// MARK: - Wire error parsing

// The gateway emits a KError at the ROOT of the error body: `{ code, message, context?, recommendation? }`, not
// wrapped in `{ error: … }`. Codes are platform-namespaced (`K9O_*`), so the prefix is stripped before matching
// the SDK's typed enum.
interface WireKError {
  code?: unknown;
  message?: unknown;
  context?: unknown;
  recommendation?: unknown;
}

/** The parts of a gateway error body this client reads. Every field falls back to an empty value. */
function parseWire(body: string | undefined): {
  code: string;
  context: Record<string, unknown>;
  recommendation: string | null;
  retryAfterSec: number | null;
} {
  const empty = { code: "", context: {}, recommendation: null, retryAfterSec: null };
  if (!body) return empty;
  let wire: WireKError | null;
  try {
    wire = JSON.parse(body) as WireKError | null;
  } catch {
    return empty;
  }
  if (typeof wire !== "object" || wire === null) return empty;
  const rec = decodeRecommendation(wire.recommendation);
  const context = typeof wire.context === "object" && wire.context !== null && !Array.isArray(wire.context) ? (wire.context as Record<string, unknown>) : {};
  return {
    code: typeof wire.code === "string" ? wire.code : "",
    context,
    recommendation: rec.text,
    retryAfterSec: rec.retryAfterSec,
  };
}

/** A string is the advice. An object gives its `action`, else its `note`; its `retryAfterSec` is the wait. Anything else gives null. */
function decodeRecommendation(raw: unknown): { text: string | null; retryAfterSec: number | null } {
  if (typeof raw === "string") return { text: raw, retryAfterSec: null };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { text: null, retryAfterSec: null };
  const r = raw as { action?: unknown; note?: unknown; retryAfterSec?: unknown };
  const text = typeof r.action === "string" ? r.action : typeof r.note === "string" ? r.note : null;
  const sec = typeof r.retryAfterSec === "number" && Number.isFinite(r.retryAfterSec) && r.retryAfterSec >= 0 ? r.retryAfterSec : null;
  return { text, retryAfterSec: sec };
}

/** A `Retry-After` value given in seconds. HTTP dates and unreadable values give null. */
function retryAfterFromHeader(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const t = value.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function gateErrorFromResponse(statusCode: number, body?: string, meta?: ResponseMeta): GateError {
  return GateError.fromResponse(statusCode, body, meta);
}
