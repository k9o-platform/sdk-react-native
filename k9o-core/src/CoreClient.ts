import { KError, readRecommendation } from "./KError";
import { resolveBaseUrl, resolveRegionalOrigin } from "./region";
import { makeFromFactory, type FromBuilder } from "./data";
import { makeQuery, type QueryParams } from "./query";
import { makeSearch, type SearchInput } from "./search";
import { makeStorageNamespace, type StorageNamespace } from "./storage";
import { makeStreamsNamespace, type StreamsNamespace } from "./streams";
import { makeMetadataNamespace, type MetadataNamespace } from "./metadata";
import { makeRealtimeNamespace, type RealtimeNamespace } from "./realtime";
import { makeVectorsNamespace, type VectorsNamespace } from "./vectors";
import { makeRampartNamespace, type RampartNamespace } from "./rampart";
import type { Transport, QueryString } from "./transport";

export interface Envelope<T> {
  data: T;
  meta: Record<string, unknown>;
}

export type FetchLike = (
  input: string,
  // `body` is a JSON string, or a FormData for file uploads. `signal` is set for streaming reads.
  init?: { method?: string; headers?: Record<string, string>; body?: any; signal?: AbortSignal },
) => Promise<Response>;

export type TokenProvider = () => string | undefined | Promise<string | undefined>;

export interface CoreClientConfig {
  /** Your organization's API host, e.g. https://acme.api.k9o.io. Optional when `orgSlug` is given. */
  baseUrl?: string | undefined;
  /** Your organization's slug. With no `baseUrl` it gives `https://<orgSlug>.api.k9o.io`; with a platform host such as `https://api.k9o.io` it gives `https://<orgSlug>.api.k9o.io`. Any other `baseUrl` is used as given. */
  orgSlug?: string | undefined;
  projectSlug?: string | undefined;
  /** Bearer token, or a (possibly async) provider called per request. */
  accessToken?: string | TokenProvider | undefined;
  /** Injectable transport; defaults to global fetch. */
  fetch?: FetchLike | undefined;
}

export interface EmbedInput {
  /** Omitted from the request when not given (server default). */
  model?: string | undefined;
  /** One string, or an array of strings. Not validated client-side. */
  input: string | readonly string[];
}

export interface EmbedResult {
  embeddings: number[][];
  model: string;
  dimensions: number;
}

export interface InferenceOptions {
  /** Model id. Omitted from the request when not given; the org's default LLM is then used. */
  model?: string | undefined;
  /** 1 to 32000. Omitted from the request when not given. */
  maxTokens?: number | undefined;
  /** 0 to 2. Omitted from the request when not given. */
  temperature?: number | undefined;
  /** Usage category recorded against the call. Omitted from the request when not given. */
  usageType?: string | undefined;
}

export interface InferenceUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface InferenceResult {
  modelId: string;
  /** The generated text. */
  content: string;
  finishReason: string | null;
  usage: InferenceUsage;
  usageType: string | null;
}

export class CoreClient {
  private readonly baseUrl: string;
  private readonly projectSlug: string | undefined;
  private readonly accessToken: string | TokenProvider | undefined;
  private readonly fetchImpl: FetchLike | undefined;
  private regionalOrigin: Promise<string> | undefined;

  readonly ai: {
    /**
     * POST /@<projectSlug>/ai/embeddings — embed one or more strings.
     *
     * The gateway refuses an end user's token; this is callable by a project
     * member's or extension's token only.
     */
    embed(input: EmbedInput): Promise<Envelope<EmbedResult>>;
    /**
     * POST /@<projectSlug>/ai/generate — run one inference call.
     *
     * Without `model` the org's default LLM is used; the gateway answers 400
     * K9O_INVALID_FIELD_VALUE when the org has none. Callable with a project
     * author's or admin's token or an extension's token. Models served by an
     * external provider answer 501 K9O_NOT_IMPLEMENTED until that provider is
     * built. The prompt never appears in errors.
     */
    generate(prompt: string, options?: InferenceOptions): Promise<Envelope<InferenceResult>>;
  };

  /** Start a data query on a collection: `from("notes").select().eq("id", "…")`, `insert`, `update`, `delete`. */
  readonly from: (collection: string) => FromBuilder;
  /** Run one read-only SQL statement. `params` is a list (`$1, $2, …`) or an object (`:name` placeholders). */
  readonly query: <T = Record<string, unknown>>(sql: string, params?: QueryParams) => Promise<Envelope<ReadonlyArray<T>>>;
  /** Full-text search over one text column of a collection, best matches first. */
  readonly search: <T = Record<string, unknown>>(collection: string, input: SearchInput) => Promise<Envelope<ReadonlyArray<T>>>;
  /** Buckets and objects: upload, list, remove, signed URLs. */
  readonly storage: StorageNamespace;
  /** User data streams: create, list, get, delete, publish, replay, subscribe. */
  readonly streams: StreamsNamespace;
  /** Embedding collections: `nearest` searches with a vector in the request body, `upsert` stores rows. */
  readonly vectors: VectorsNamespace;
  /** Declared columns on a collection: `filter`, `set`, `search`, `vectors.nearest`, `index.get` and `index.declare`. */
  readonly metadata: MetadataNamespace;
  /** Realtime: `subscribe` (a reconnecting change feed over SSE) and `replay` (ledger catch-up). */
  readonly realtime: RealtimeNamespace;
  /** Hosted classification (advisory): `rampart.classify()`, `.jwks()` and `.verifyReceipt()`. */
  readonly rampart: RampartNamespace;

  constructor(config: CoreClientConfig) {
    this.baseUrl = resolveBaseUrl(config.baseUrl, config.orgSlug);
    this.projectSlug = config.projectSlug;
    this.accessToken = config.accessToken;
    this.fetchImpl = config.fetch;
    this.ai = {
      embed: (input) => this.embed(input),
      generate: (prompt, options) => this.generate(prompt, options),
    };
    const transport: Transport = {
      projectSlug: (feature) => this.requireSlug(feature),
      request: (method, path, opts) => this.request(method, path, opts?.body, opts?.query),
      getJson: (path) => this.getJson(path),
      stream: (path, opts) => this.openStream(path, opts?.query, opts?.signal, opts?.headers),
    };
    this.from = makeFromFactory(transport);
    this.query = makeQuery(transport);
    this.search = makeSearch(transport);
    this.storage = makeStorageNamespace(transport);
    this.streams = makeStreamsNamespace(transport);
    this.vectors = makeVectorsNamespace(transport);
    this.metadata = makeMetadataNamespace(transport);
    this.realtime = makeRealtimeNamespace(transport);
    this.rampart = makeRampartNamespace(transport);
  }

  private requireSlug(feature: string): string {
    if (typeof this.projectSlug !== "string" || this.projectSlug.length === 0) {
      throw new KError({
        code: "K9O_MISSING_PROJECT_CONTEXT",
        message: `${feature} requires projectSlug bound on the client`,
        recommendation: "Construct CoreClient with a projectSlug.",
      });
    }
    return this.projectSlug;
  }

  private async embed(input: EmbedInput): Promise<Envelope<EmbedResult>> {
    if (typeof this.projectSlug !== "string" || this.projectSlug.length === 0) {
      throw new KError({
        code: "K9O_MISSING_PROJECT_CONTEXT",
        message: "ai.embed requires projectSlug bound on the client",
        recommendation: "Construct CoreClient with a projectSlug.",
      });
    }
    const body: { model?: string; input: string | string[] } = {
      input: typeof input.input === "string" ? input.input : [...input.input],
    };
    if (input.model !== undefined) body.model = input.model;
    return this.request<EmbedResult>("POST", `/@${this.projectSlug}/ai/embeddings`, body);
  }

  private async generate(prompt: string, options: InferenceOptions = {}): Promise<Envelope<InferenceResult>> {
    if (typeof this.projectSlug !== "string" || this.projectSlug.length === 0) {
      throw new KError({
        code: "K9O_MISSING_PROJECT_CONTEXT",
        message: "ai.generate requires projectSlug bound on the client",
        recommendation: "Construct CoreClient with a projectSlug.",
      });
    }
    const body: { prompt: string; model?: string; maxTokens?: number; temperature?: number; usageType?: string } = { prompt };
    if (options.model !== undefined) body.model = options.model;
    if (options.maxTokens !== undefined) body.maxTokens = options.maxTokens;
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.usageType !== undefined) body.usageType = options.usageType;
    return this.request<InferenceResult>("POST", `/@${this.projectSlug}/ai/generate`, body);
  }

  private async buildHeaders(accept: string): Promise<Record<string, string>> {
    const headers: Record<string, string> = { accept };
    const token = typeof this.accessToken === "function" ? await this.accessToken() : this.accessToken;
    if (typeof token === "string" && token.length > 0) headers["authorization"] = `Bearer ${token}`;
    return headers;
  }

  /**
   * The origin requests go to. A region-free org address (`<org>.api.<rest>`) refuses credentials, so one
   * credential-free HEAD learns the regional host; it is cached for the life of the client. Regional and
   * other addresses are used as given, with no probe. A network failure during the probe is not cached.
   */
  private origin(): Promise<string> {
    if (this.regionalOrigin === undefined) {
      const fetchImpl: FetchLike = this.fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
      const p = resolveRegionalOrigin(this.baseUrl, fetchImpl as unknown as typeof fetch).then((r) => {
        if (!r.cacheable) this.regionalOrigin = undefined;
        return r.origin;
      });
      this.regionalOrigin = p;
    }
    return this.regionalOrigin;
  }

  private urlFor(origin: string, path: string, query?: QueryString): string {
    let url = `${origin}${path}`;
    if (query !== undefined) {
      const parts: string[] = [];
      // Not URLSearchParams: older React Native versions do not implement its toString().
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      }
      if (parts.length > 0) url += `?${parts.join("&")}`;
    }
    return url;
  }

  /** Open a Server-Sent Events read. Returns the live response on 2xx; throws KError otherwise. */
  private async openStream(path: string, query?: QueryString, signal?: AbortSignal, extra?: Record<string, string>): Promise<Response> {
    const url = this.urlFor(await this.origin(), path, query);
    const headers = { ...(await this.buildHeaders("text/event-stream")), ...(extra ?? {}) };
    const init: { method: string; headers: Record<string, string>; signal?: AbortSignal } = { method: "GET", headers };
    if (signal !== undefined) init.signal = signal;
    const fetchImpl: FetchLike = this.fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new KError({
        code: "K9O_UPSTREAM_UNAVAILABLE",
        message: `Network error reaching ${url}: ${e instanceof Error ? e.message : String(e)}`,
        context: { url },
        recommendation: "Check connectivity to the gateway; retry with backoff if transient.",
        cause: e,
      });
    }
    if (response.status < 200 || response.status >= 300) {
      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        /* non-JSON error body */
      }
      throw this.errorFrom(parsed, url, response.status, headerRequestId(response));
    }
    return response;
  }

  /** One call: returns the parsed JSON body of a 2xx answer (`undefined` for 204); throws KError for anything else. */
  private async send(method: string, path: string, body?: unknown, query?: QueryString): Promise<{ parsed: unknown; url: string; status: number }> {
    const url = this.urlFor(await this.origin(), path, query);
    const headers = await this.buildHeaders("application/json");
    const init: { method: string; headers: Record<string, string>; body?: unknown } = { method, headers };
    if (body !== undefined) {
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        // Multipart: the runtime sets the content type with its boundary.
        init.body = body;
      } else {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
    }

    const fetchImpl: FetchLike = this.fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (e) {
      // Never include the request body in error text.
      throw new KError({
        code: "K9O_UPSTREAM_UNAVAILABLE",
        message: `Network error reaching ${url}: ${e instanceof Error ? e.message : String(e)}`,
        context: { url },
        recommendation: "Check connectivity to the gateway; retry with backoff if transient.",
        cause: e,
      });
    }

    if (response.status === 204) return { parsed: undefined, url, status: 204 };

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new KError({
        code: "K9O_INTERNAL_ERROR",
        message: `Non-JSON response from ${url} (HTTP ${response.status})`,
        context: { url, status: response.status },
        status: response.status,
        requestId: headerRequestId(response),
      });
    }

    if (response.status >= 200 && response.status < 300) return { parsed, url, status: response.status };
    throw this.errorFrom(parsed, url, response.status, headerRequestId(response));
  }

  private async getJson(path: string): Promise<unknown> {
    return (await this.send("GET", path)).parsed;
  }

  private async request<T>(method: string, path: string, body?: unknown, query?: QueryString): Promise<Envelope<T>> {
    const { parsed, url, status } = await this.send(method, path, body, query);
    if (status === 204) return { data: undefined as unknown as T, meta: {} };
    if (typeof parsed !== "object" || parsed === null || !("data" in parsed)) {
      throw new KError({
        code: "K9O_INTERNAL_ERROR",
        message: `Malformed envelope from ${url}: expected {data, meta}`,
        context: { url, status },
        status,
      });
    }
    const env = parsed as { data: T; meta?: Record<string, unknown> | null };
    return { data: env.data, meta: env.meta ?? {} };
  }

  private errorFrom(parsed: unknown, url: string, status: number, headerId: string | null = null): KError {
    const wire = parsed as Partial<{ code: unknown; message: unknown; context: unknown; recommendation: unknown; requestId: unknown }> | null;
    if (wire && typeof wire === "object" && typeof wire.code === "string") {
      const rec = readRecommendation(wire.recommendation);
      return new KError({
        code: wire.code,
        message: typeof wire.message === "string" ? wire.message : wire.code,
        context: wire.context && typeof wire.context === "object" ? (wire.context as Record<string, unknown>) : {},
        recommendation: rec.recommendation,
        status,
        requestId: typeof wire.requestId === "string" ? wire.requestId : headerId,
        retryAfterSec: rec.retryAfterSec,
      });
    }
    return new KError({
      code: "K9O_INTERNAL_ERROR",
      message: `Unrecognised error body from ${url} (HTTP ${status})`,
      context: { url, status },
      status,
      requestId: headerId,
    });
  }
}

/** The gateway's request id from the `x-k9o-request-id` response header (names are case-insensitive), or null. */
function headerRequestId(response: Response): string | null {
  const v = response.headers?.get?.("x-k9o-request-id");
  return typeof v === "string" && v !== "" ? v : null;
}
