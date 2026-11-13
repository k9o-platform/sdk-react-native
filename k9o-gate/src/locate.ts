/**
 * Locating the end user's region for password sign-in.
 *
 * `region.ts` finds the org's regional API host. An end user can live in another region of the project, so sign-in first
 * asks the project which region holds the address (`POST /@<projectSlug>/gate/locate { email }` at that regional base)
 * and sends the credential to the origin it names. The answer is the same for a known and an unknown address.
 *
 * Rules:
 *   - The located origin is used for that one attempt. It is never cached as authority. The one thing kept is a hint, per
 *     refresh token, so that refresh and sign-out reach the region that issued the session; a stale hint gets a 401.
 *   - An origin is used only if it is `https` (`http` only when the base is itself `http` on a loopback host), has no
 *     userinfo, port, path, query or fragment, and its host is exactly the base host's org, family and apex with the
 *     region code `[a-z]{2}\d{2}` added or swapped in the service label, and that code equals the answer's `region`.
 *     Anything else, or `origin: null`, means the base is used. A password never goes to a host that fails this.
 *
 * URLs are read with a small parser rather than the `URL` class, which React Native only partly implements.
 */

import { parseApiHost } from "./region";

const REGION_CODE = /^[a-z]{2}\d{2}$/;

type Parts = { protocol: string; hostname: string; host: string; userinfo: boolean; port: string; path: string; query: boolean; fragment: boolean };

/** Split an absolute http(s) URL into the parts the rule looks at; null when it is not one. */
function parseUrl(url: string): Parts | null {
  const m = /^(https?):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(url);
  if (m === null) return null;
  let authority = m[2]!;
  const at = authority.lastIndexOf("@");
  const userinfo = at >= 0;
  if (userinfo) authority = authority.slice(at + 1);
  let hostname: string;
  let port = "";
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) return null;
    hostname = authority.slice(0, close + 1);
    const rest = authority.slice(close + 1);
    if (rest.startsWith(":")) port = rest.slice(1);
    else if (rest !== "") return null;
  } else {
    const colon = authority.indexOf(":");
    hostname = colon >= 0 ? authority.slice(0, colon) : authority;
    port = colon >= 0 ? authority.slice(colon + 1) : "";
  }
  hostname = hostname.toLowerCase();
  if (hostname.length === 0) return null;
  return {
    protocol: m[1]!.toLowerCase() + ":",
    hostname,
    host: port === "" ? hostname : `${hostname}:${port}`,
    userinfo,
    port,
    path: m[3] ?? "",
    query: m[4] !== undefined,
    fragment: m[5] !== undefined,
  };
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * The origin the credential goes to: the located one if it passes the rule, else `base`. Pure; never throws.
 * `answer` is the `data` of the locate envelope.
 */
export function chooseLocatedOrigin(base: string, answer: unknown): string {
  try {
    if (answer === null || typeof answer !== "object") return base;
    const { region, origin } = answer as { region?: unknown; origin?: unknown };
    if (typeof origin !== "string" || typeof region !== "string" || !REGION_CODE.test(region)) return base;
    const b = parseUrl(base);
    const u = parseUrl(origin);
    if (b === null || u === null) return base;
    if (u.userinfo || u.port !== "" || u.query || u.fragment) return base;
    if (u.path !== "" && u.path !== "/") return base;
    if (u.protocol !== "https:" && !(u.protocol === "http:" && b.protocol === "http:" && isLoopback(b.hostname) && isLoopback(u.hostname))) return base;
    if (u.protocol === b.protocol && u.host === b.host) return `${b.protocol}//${b.host}`;
    const from = parseApiHost(b.hostname);
    const to = parseApiHost(u.hostname);
    if (from === null || to === null || to.region !== region) return base;
    if (from.orgSlug !== to.orgSlug || from.family !== to.family || from.apex !== to.apex) return base;
    return `${u.protocol}//${u.host}`;
  } catch {
    return base;
  }
}

const HINT_LIMIT = 64;
const hints = new Map<string, string>();

/** Remember which origin issued the session with this refresh token (a hint, not authority). */
export function rememberSessionOrigin(refreshToken: string | undefined, origin: string): void {
  if (typeof refreshToken !== "string" || refreshToken.length === 0) return;
  hints.delete(refreshToken);
  hints.set(refreshToken, origin);
  while (hints.size > HINT_LIMIT) hints.delete(hints.keys().next().value as string);
}

export function sessionOriginHint(refreshToken: string): string | undefined {
  return hints.get(refreshToken);
}

export function forgetSessionOrigin(refreshToken: string): void {
  hints.delete(refreshToken);
}
