/**
 * Regional host resolution for React Native.
 *
 * A region-free org host `<org>.api.<rest>` (or `<org>.api-staging.<rest>`) refuses a request that carries a body or an
 * `Authorization` header, so credentials must go to the regional host `<org>.api-<rgn>.<rest>`. The client learns the
 * region with ONE unauthenticated `HEAD` to the configured host and caches the regional origin.
 *
 * Nothing here knows an apex: the host comes from the configured base URL, so a public-cloud, internal-apex,
 * air-gapped or localhost deployment all work. Only a host shaped `<org>.api.<rest>` is probed; any other base URL is
 * used exactly as given. The regional origin is trusted only if it is `https`, has no userinfo or port, and is exactly
 * the same org, gateway family and apex with a region code. Anything else is ignored, so a hostile redirect can never
 * receive a credential.
 *
 * React Native's `fetch` follows redirects itself and does not honour `redirect: "manual"`, so the probe reads either the
 * `308` `Location` (where the runtime exposes it) or the final `response.url` after the redirect was followed.
 *
 * URLs are read with a small parser rather than the `URL` class, which React Native only partly implements.
 */

import { KError } from "./KError";

export type ApiHost = {
  /** First label of an org host; null for a platform host (`api.<apex>`). */
  orgSlug: string | null;
  family: "api" | "api-staging";
  /** 4-character region code when the host is regional (`api-de01`), else null. */
  region: string | null;
  /** Everything after the gateway label. */
  apex: string;
};

const API_LABEL = /^(api|api-staging)(?:-([a-z]{2}\d{2}))?$/;
const SLUG_RE = /^[a-z][a-z0-9-]{1,62}$/;

/** Read the org slug and region out of a gateway host without knowing its apex; null for any other shape. */
export function parseApiHost(host: string): ApiHost | null {
  const labels = host.toLowerCase().split(".");
  if (labels.some((l) => l.length === 0)) return null;
  const mk = (gatewayLabel: string, orgSlug: string | null, rest: string[]): ApiHost | null => {
    const m = API_LABEL.exec(gatewayLabel);
    if (m === null || rest.length === 0) return null;
    return { orgSlug, family: m[1] as "api" | "api-staging", region: m[2] ?? null, apex: rest.join(".") };
  };
  if (labels.length >= 3 && SLUG_RE.test(labels[0]!) && !labels[0]!.endsWith("-") && API_LABEL.test(labels[1]!)) {
    return mk(labels[1]!, labels[0]!, labels.slice(2));
  }
  if (labels.length >= 2 && API_LABEL.test(labels[0]!)) return mk(labels[0]!, null, labels.slice(1));
  return null;
}

type Origin = { protocol: string; userinfo: boolean; hostname: string; port: string };

/** Parse an absolute http(s) URL's origin parts; null when it is not one. */
function parseOrigin(url: string): Origin | null {
  const m = /^(https?):\/\/([^/?#]*)/i.exec(url);
  if (m === null) return null;
  let authority = m[2]!;
  const at = authority.lastIndexOf("@");
  const userinfo = at >= 0;
  if (userinfo) authority = authority.slice(at + 1);
  if (authority.startsWith("[")) return null; // IPv6 literal: not a gateway host
  const colon = authority.indexOf(":");
  const hostname = (colon >= 0 ? authority.slice(0, colon) : authority).toLowerCase();
  const port = colon >= 0 ? authority.slice(colon + 1) : "";
  if (hostname.length === 0) return null;
  return { protocol: m[1]!.toLowerCase() + ":", userinfo, hostname, port };
}

/** The public-cloud API domain used when only an `orgSlug` is given. Never used to parse a host. */
const DEFAULT_ORG_APEX = "api.k9o.io";

/**
 * The effective base URL from `baseUrl` and `orgSlug`.
 *
 * A platform host (`api.<apex>` or `api-staging.<apex>`, any apex, with no org label and no region) plus an `orgSlug`
 * becomes `<scheme>://<orgSlug>.<host>` (the port is kept). Any other base URL (an org host, a regional host, a custom
 * domain, localhost, an IP) is used exactly as given and `orgSlug` is ignored. With no base URL, `orgSlug` gives
 * `https://<orgSlug>.api.k9o.io`. With neither, construction fails.
 */
export function resolveBaseUrl(baseUrl: string | undefined, orgSlug?: string): string {
  const given = typeof baseUrl === "string" && baseUrl.trim().length > 0 ? baseUrl.trim() : undefined;
  const slug = typeof orgSlug === "string" && orgSlug.length > 0 ? orgSlug : undefined;
  if (given === undefined) {
    if (slug === undefined) {
      throw new KError({
        code: "K9O_INVALID_BASE_URL",
        message: "Pass baseUrl (for example https://acme.api.k9o.io) or orgSlug",
        context: { field: "baseUrl" },
        recommendation: "Pass `orgSlug` for your organization, or a full `baseUrl` such as https://<orgSlug>.api.k9o.io",
        status: null,
      });
    }
    checkOrgSlug(slug);
    return `https://${slug}.${DEFAULT_ORG_APEX}`;
  }
  const configured = given.replace(/\/+$/, "");
  if (slug === undefined) return configured;
  const m = /^(https?):\/\/([^/?#@]*)$/i.exec(configured);
  if (m === null) return configured;
  const authority = m[2]!;
  const colon = authority.indexOf(":");
  const hostname = colon >= 0 ? authority.slice(0, colon) : authority;
  const host = parseApiHost(hostname);
  if (host === null || host.orgSlug !== null || host.region !== null) return configured;
  checkOrgSlug(slug);
  return `${m[1]!.toLowerCase()}://${slug}.${authority}`;
}

function checkOrgSlug(slug: string): void {
  if (!SLUG_RE.test(slug) || slug.endsWith("-")) {
    throw new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `orgSlug "${slug}" does not match required format ^[a-z][a-z0-9-]{1,62}$ (must not end with '-')`,
      context: { field: "orgSlug", slug },
      recommendation: "Pass a slug of lowercase letters, digits and hyphens; 2-63 characters; starts with a letter; does not end with a hyphen.",
      status: null,
    });
  }
}

/** The regional origin a URL may name for `host`, or null if it is not exactly that. Pure. */
export function regionalOriginFromLocation(host: string, location: string): string | null {
  const from = parseApiHost(host);
  if (from === null || from.orgSlug === null || from.region !== null) return null;
  const u = parseOrigin(location);
  if (u === null || u.protocol !== "https:" || u.userinfo || u.port !== "") return null;
  const to = parseApiHost(u.hostname);
  if (to === null || to.region === null) return null;
  if (to.orgSlug !== from.orgSlug || to.family !== from.family || to.apex !== from.apex) return null;
  return `https://${u.hostname}`;
}

/** The origin requests go to: the regional origin when the configured one is region-free and redirects, else as given. */
export async function resolveRegionalOrigin(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ origin: string; cacheable: boolean }> {
  const configured = baseUrl.replace(/\/+$/, "");
  const parsed = parseOrigin(configured);
  if (parsed === null) return { origin: configured, cacheable: true };
  const host = parseApiHost(parsed.hostname);
  if (host === null || host.orgSlug === null || host.region !== null) return { origin: configured, cacheable: true };
  try {
    const res = await fetchImpl(`${configured}/`, { method: "HEAD", redirect: "manual", headers: { Accept: "*/*" } });
    const location = res.status === 308 ? res.headers?.get?.("location") ?? null : null;
    const named = location ?? (typeof res.url === "string" && res.url.length > 0 ? res.url : null);
    const origin = named === null ? null : regionalOriginFromLocation(parsed.hostname, named);
    // A gateway-side failure (5xx) on the probe says nothing about the region: do not cache it.
    return { origin: origin ?? configured, cacheable: !(res.status >= 500 && origin === null) };
  } catch {
    return { origin: configured, cacheable: false };
  }
}
