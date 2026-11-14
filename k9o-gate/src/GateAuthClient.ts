import { ErrorsMode, GateError, gateErrorFromResponse } from "./GateError";
import { parseEnvelope } from "./Models";
import { chooseLocatedOrigin } from "./locate";
import { resolveBaseUrl, resolveRegionalOrigin } from "./region";

/** A response header's value, or null when absent or when the runtime gives no header access. */
function header(response: Response, name: string): string | null {
  try {
    const value = response.headers?.get?.(name);
    return value ? value : null;
  } catch {
    return null;
  }
}

/**
 * Internal fetch-based transport layer for @k9o/gate-react-native.
 * Constructs URLs using the `/@<projectSlug>/gate/<suffix>` grammar; `area` names another path root, for example `auth`.
 */
export class GateAuthClient {
  private readonly baseUrl: string;
  private readonly projectSlug: string;
  private readonly errors: ErrorsMode;
  private origin: Promise<string> | null = null;

  constructor(orgBaseUrl: string | undefined, projectSlug: string, orgSlug?: string, errors: ErrorsMode = "full") {
    this.baseUrl = resolveBaseUrl(orgBaseUrl, orgSlug);
    this.projectSlug = projectSlug;
    this.errors = errors;
  }

  /** The origin credentials go to: the regional host when the base URL is a region-free org host, else the base URL. */
  private resolveOrigin(): Promise<string> {
    if (this.origin === null) {
      const p = resolveRegionalOrigin(this.baseUrl).then((r) => {
        if (!r.cacheable) this.origin = null;
        return r.origin;
      });
      this.origin = p;
    }
    return this.origin;
  }

  /**
   * Ask the project which region holds `email` and return the origin the credential goes to: the located origin if it
   * passes the rule in `locate.ts`, else the base. A 404 from the door means the base. Other door errors (429, 503, anything else non-2xx) are raised like any other
   * gateway error and nothing is retried; a 2xx with a malformed body means the base.
   */
  async locate(email: string): Promise<string> {
    const base = await this.resolveOrigin();
    try {
      const data = await this.send<{ region?: unknown; origin?: unknown } | undefined>(base, "locate", { email }, true);
      return chooseLocatedOrigin(base, data);
    } catch (e) {
      // A door that is switched off answers 404: no located origin, so the base is used. Every other failure raises.
      if (e instanceof GateError && e.statusCode === 404) return base;
      throw e;
    }
  }

  /** The origin recorded for a session's refresh token, else the base. A hint only: a stale one gets a 401. */
  async originFor(hint: string | undefined): Promise<string> {
    return hint ?? (await this.resolveOrigin());
  }

  /** `body` is omitted for a route that reads none; `bearer` adds an `Authorization` header; `area` replaces the `gate` path root. */
  async post<T>(
    path: string,
    body: Record<string, unknown> | undefined,
    origin?: string,
    opts: { area?: string; bearer?: string } = {},
  ): Promise<T> {
    return this.send<T>(origin ?? (await this.resolveOrigin()), path, body, false, opts) as Promise<T>;
  }

  /** A bodiless `GET` with a bearer token. */
  async get<T>(path: string, opts: { bearer?: string } = {}): Promise<T> {
    return this.send<T>(await this.resolveOrigin(), path, undefined, false, { ...opts, method: "GET" }) as Promise<T>;
  }

  /** A `DELETE`; `body` is omitted when there is nothing to send. */
  async delete<T>(path: string, body: Record<string, unknown> | undefined, opts: { bearer?: string } = {}): Promise<T> {
    return this.send<T>(await this.resolveOrigin(), path, body, false, { ...opts, method: "DELETE" }) as Promise<T>;
  }

  private async send<T>(
    origin: string,
    path: string,
    body: Record<string, unknown> | undefined,
    lenient: boolean,
    opts: { area?: string; bearer?: string; method?: string } = {},
  ): Promise<T | undefined> {
    let response: Response;
    try {
      response = await fetch(`${origin}/@${this.projectSlug}/${opts.area ?? "gate"}/${path}`, {
        method: opts.method ?? "POST",
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          Accept: "application/json",
          ...(opts.bearer !== undefined ? { Authorization: `Bearer ${opts.bearer}` } : {}),
          "User-Agent": "k9o-react-native-sdk",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw GateError.network(e, { errors: this.errors });
    }

    const text = await response.text().catch(() => undefined as string | undefined);
    const requestId = header(response, "x-k9o-request-id");

    if (!response.ok) {
      throw gateErrorFromResponse(response.status, text, {
        requestId,
        retryAfter: header(response, "retry-after"),
        errors: this.errors,
      });
    }

    try {
      return parseEnvelope<T>(text ?? "");
    } catch (e) {
      if (lenient) return undefined;
      throw GateError.decoding(e, { requestId, errors: this.errors });
    }
  }
}
