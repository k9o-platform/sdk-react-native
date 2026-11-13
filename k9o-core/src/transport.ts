import type { Envelope } from "./CoreClient";
import { KError } from "./KError";

/** Query-string values; `undefined` entries are skipped. */
export type QueryString = Record<string, string | number | boolean | undefined>;

/** What the data, query, search, storage and streams modules need from the client. */
export interface Transport {
  /** The bound project slug; throws K9O_MISSING_PROJECT_CONTEXT (naming `feature`) when there is none. */
  projectSlug(feature: string): string;
  request<T>(method: string, path: string, opts?: { body?: unknown; query?: QueryString }): Promise<Envelope<T>>;
  /** A GET whose 2xx body is returned as parsed JSON, not read as an envelope (for public feeds such as `/rampart/jwks`). Throws KError otherwise. */
  getJson(path: string): Promise<unknown>;
  /** Open an SSE read; resolves to the live response on 2xx, throws KError otherwise. */
  stream(path: string, opts?: { query?: QueryString; signal?: AbortSignal | undefined; headers?: Record<string, string> | undefined }): Promise<Response>;
}

const SLUG_RE = /^[a-z][a-z0-9-]{1,62}$/;

/** `/@<projectSlug>/<sub>`, with the slug checked for shape. */
export function projectPath(t: Transport, feature: string, sub: string): string {
  const slug = t.projectSlug(feature);
  if (!SLUG_RE.test(slug) || slug.endsWith("-")) {
    throw invalidField(`projectSlug "${slug}" does not match required format ^[a-z][a-z0-9-]{1,62}$ (must not end with '-')`, { slug });
  }
  return `/@${slug}/${sub.startsWith("/") ? sub.slice(1) : sub}`;
}

export function invalidField(message: string, context: Record<string, unknown> = {}, recommendation: string | null = null): KError {
  return new KError({ code: "K9O_INVALID_FIELD_VALUE", message, context, recommendation });
}
