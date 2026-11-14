/**
 * Rampart SDK: `client.rampart.*`. Rampart classifies content you hand it as `clear`, `suspicious` or `malicious`
 * and signs a receipt for the verdict. It is advisory: it returns a verdict or an error and blocks nothing; your
 * code decides what to do with the content.
 *
 * Wire mapping:
 *   - `classify(input, { label? })`   -> POST /@<slug>/rampart/classify   { input, label? }
 *   - `jwks()`                        -> GET  /rampart/jwks               (public; no project prefix)
 *   - `verifyReceipt(receipt, input)` -> local; fetches `jwks()` itself when you pass no key set
 *
 * Long input is not truncated: it is scored in overlapping windows and the highest injection score decides. Past 16
 * windows (about 6,000 tokens) `classify` throws `KError` 413 `K9O_RAMPART_INPUT_TOO_LONG` and gives no verdict.
 *
 * Failing closed: while the classifier cannot answer, `classify` throws `KError` 503
 * `K9O_RAMPART_CLASSIFIER_UNAVAILABLE`. You get no verdict, never a default "clear".
 *
 * A receipt is an EdDSA JWS. `verifyReceipt` accepts it only when, in this order: the key named by the header `kid`
 * is in the key feed, `alg` is `EdDSA`, `typ` is `k9o.rampart.classify.v1`, the signature verifies, the issuer
 * (advertised by the key feed, or your `issuer` option) and project match, the receipt is within its time window
 * (plus a clock skew), and its `input_sha256` equals the SHA-256 of the canonical form (the platform's JSON profile:
 * keys sorted by UTF-8 byte order, integers only) of the exact input you pass. Any failure throws
 * `RampartReceiptError` with a `reason`; there is no partial verdict. The verdict you get back is read from the
 * verified claims.
 */

import type { Envelope } from "./CoreClient";
import { KError } from "./KError";
import { invalidField, projectPath, type Transport } from "./transport";
import { canonicalize } from "./jcs";
import { sha256Hex } from "./sha256";
import { ed25519Verify } from "./ed25519";
import { utf8Encode, utf8DecodeStrict } from "./utf8";

export type RampartClassification = "clear" | "suspicious" | "malicious";

/** The verdict and its receipt, as the gateway sent them. */
export type RampartVerdict = {
  classification: RampartClassification;
  /** Risk in basis points, an integer 0 to 10000. */
  riskScore: number;
  /** Confidence in basis points, an integer 0 to 10000. */
  confidence: number;
  categories: string[];
  calibrationVersion: string;
  /** The signed receipt (a compact JWS), exactly as received. Pass it to `verifyReceipt`. */
  classificationReceipt: string;
  /** The project id (`proj_...`) the receipt names, when the gateway reports it. `verifyReceipt` compares it to the signed claim. */
  projectId?: string | undefined;
};

/** What `classify` returns, and what `verifyReceipt` accepts in place of a bare receipt string. */
export type RampartClassifyResult = Envelope<RampartVerdict> | RampartVerdict;

export type RampartClassifyOptions = {
  /** A context label, 1 to 128 characters. */
  label?: string | undefined;
};

/** One public key of the feed (an Ed25519 JWK). */
export type RampartJwk = {
  kty: string;
  crv?: string;
  x?: string;
  kid: string;
  alg?: string;
  use?: string;
  [member: string]: unknown;
};

/** The key feed: the keys and the issuer receipts carry (`<issuer>/rampart`). `issuer` is absent when the gateway does not advertise one. */
export type RampartJwks = { keys: RampartJwk[]; issuer?: string | undefined };

/** Why a receipt was refused. The set is closed. */
export type RampartReceiptReason =
  | "malformed"
  | "key_unavailable"
  | "key_unknown"
  | "alg"
  | "typ"
  | "signature"
  | "issuer"
  | "project"
  | "project_unknown"
  | "expired"
  | "not_yet_valid"
  | "input_hash";

export const RAMPART_RECEIPT_REASONS: ReadonlyArray<RampartReceiptReason> = [
  "malformed", "key_unavailable", "key_unknown", "alg", "typ", "signature", "issuer", "project", "project_unknown", "expired", "not_yet_valid", "input_hash",
];

/** Thrown by `verifyReceipt` for every refusal. */
export class RampartReceiptError extends Error {
  readonly reason: RampartReceiptReason;
  readonly detail: string;
  constructor(reason: RampartReceiptReason, detail: string, options?: { cause?: unknown }) {
    super(`rampart receipt refused (${reason}): ${detail}`, options);
    this.name = "RampartReceiptError";
    this.reason = reason;
    this.detail = detail;
  }
}

export type RampartVerifyOptions = {
  /** A key set you already fetched (`jwks()`, which also supplies the issuer), or just its `keys`. Without it the SDK fetches the feed itself. */
  keys?: RampartJwks | ReadonlyArray<RampartJwk> | undefined;
  /**
   * The issuer the receipt must carry. Default: the `issuer` the key feed advertises. When neither exists the receipt
   * is refused (`issuer`).
   */
  issuer?: string | undefined;
  /**
   * The project id the receipt must name. Default: the `projectId` carried by the classify result you pass in place
   * of a receipt string. A bare receipt string with neither is refused (`project_unknown`); a different id is
   * refused (`project`).
   */
  projectId?: string | undefined;
  /** Seconds of clock difference tolerated at both ends of the window. Default 60. */
  clockSkewSeconds?: number | undefined;
  /** The clock, for tests. Default: the current time. */
  now?: (() => Date) | undefined;
};

/** The claims of a receipt that passed every check. */
export type RampartVerified = {
  classification: RampartClassification;
  riskScore: number;
  confidence: number;
  categories: string[];
  calibrationVersion: string;
  projectId: string;
  /** Lowercase hex SHA-256 of the canonical input. */
  inputSha256: string;
  issuer: string;
  /** How many windows of the input were scored (1 when it fits one window). A receipt without the claim reads as 1. */
  windows: number;
  /** Seconds since the epoch. */
  issuedAt: number;
  expiresAt: number;
  kid: string;
};

export const RAMPART_RECEIPT_TYP = "k9o.rampart.classify.v1";

/** Error codes `classify` can throw (as `KError.code`) that mean there is no verdict. */
export const RAMPART_ERROR_CODES = {
  /** 413: the input needs more than 16 windows (about 6,000 tokens). `context.reason` is `rampart_input_too_long`. Send a shorter input. */
  inputTooLong: "K9O_RAMPART_INPUT_TOO_LONG",
  /** 503: the classifier could not answer. Retry later. */
  classifierUnavailable: "K9O_RAMPART_CLASSIFIER_UNAVAILABLE",
} as const;

/** True when `e` is the 413 for an input past 16 windows: no verdict was made. */
export function isRampartInputTooLong(e: unknown): e is KError {
  return e instanceof KError && e.code === RAMPART_ERROR_CODES.inputTooLong;
}

const B64URL = /^[A-Za-z0-9_-]*$/;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function b64urlDecode(s: string): Uint8Array {
  if (!B64URL.test(s) || s.length % 4 === 1) throw new RampartReceiptError("malformed", "a receipt part is not base64url");
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    acc = (acc << 6) | ALPHABET.indexOf(s.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

function b64urlJson(s: string, what: string): Record<string, unknown> {
  const text = utf8DecodeStrict(b64urlDecode(s));
  let v: unknown;
  try {
    if (text === null) throw new Error("not UTF-8");
    v = JSON.parse(text);
  } catch {
    throw new RampartReceiptError("malformed", `the receipt ${what} is not JSON`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new RampartReceiptError("malformed", `the receipt ${what} is not an object`);
  return v as Record<string, unknown>;
}

function isBp(v: unknown): v is number {
  return typeof v === "number" && Math.floor(v) === v && v >= 0 && v <= 10000;
}

/** The 32 key bytes of an Ed25519 JWK, or a `key_unknown` refusal. */
function keyBytes(jwk: RampartJwk): Uint8Array {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new RampartReceiptError("key_unknown", "the key named by the receipt is not an Ed25519 key");
  }
  const raw = b64urlDecodeKey(jwk.x);
  if (raw === null || raw.length !== 32) throw new RampartReceiptError("key_unknown", "the key named by the receipt could not be loaded");
  return raw;
}

function b64urlDecodeKey(x: string): Uint8Array | null {
  try {
    return b64urlDecode(x);
  } catch {
    return null;
  }
}

function keyList(k: RampartJwks | ReadonlyArray<RampartJwk>): ReadonlyArray<RampartJwk> {
  return Array.isArray(k) ? (k as ReadonlyArray<RampartJwk>) : (k as RampartJwks).keys;
}

export function makeRampartNamespace(t: Transport) {
  let cached: { keys: Map<string, RampartJwk>; issuer: string | undefined } | null = null;
  let inflight: Promise<RampartJwks> | null = null;

  async function fetchFeed(): Promise<RampartJwks> {
    const body = await t.getJson("/rampart/jwks");
    const keys = (body as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === "object" && k !== null && typeof (k as RampartJwk).kid === "string")) {
      throw new KError({ code: "K9O_INTERNAL_ERROR", message: "The Rampart key feed is malformed: expected { keys: [...] }", context: {} });
    }
    const issuer = (body as { issuer?: unknown }).issuer;
    const feed: RampartJwks = { keys: keys as RampartJwk[], ...(typeof issuer === "string" && issuer.length > 0 ? { issuer } : {}) };
    const map = new Map<string, RampartJwk>();
    for (const k of feed.keys) map.set(k.kid, k);
    cached = { keys: map, issuer: feed.issuer };
    return feed;
  }

  function jwks(): Promise<RampartJwks> {
    if (inflight === null) {
      const done = (): void => { inflight = null; };
      inflight = fetchFeed();
      inflight.then(done, done);
    }
    return inflight;
  }

  async function keyFor(kid: string, injected: RampartVerifyOptions["keys"]): Promise<{ jwk: RampartJwk; issuer: string | undefined }> {
    if (injected !== undefined) {
      const k = keyList(injected).find((x) => x.kid === kid);
      if (k === undefined) throw new RampartReceiptError("key_unknown", "no key with the receipt's kid in the key set you passed");
      return { jwk: k, issuer: Array.isArray(injected) ? undefined : (injected as RampartJwks).issuer };
    }
    try {
      let freshlyFetched = false;
      if (cached === null) { await jwks(); freshlyFetched = true; }
      let k = cached!.keys.get(kid);
      if (k === undefined && !freshlyFetched) { await jwks(); k = cached!.keys.get(kid); } // refetch once on an unknown kid
      if (k === undefined) throw new RampartReceiptError("key_unknown", "no key with the receipt's kid in the key feed");
      return { jwk: k, issuer: cached!.issuer };
    } catch (e) {
      if (e instanceof RampartReceiptError) throw e;
      throw new RampartReceiptError("key_unavailable", "the key feed could not be read", { cause: e });
    }
  }

  return {
    /**
     * Classify `input` (a JSON object). The answer holds the verdict fields, `classificationReceipt` and (when the
     * gateway reports it) `projectId`, as received; the verdict is not checked until you call `verifyReceipt`. The
     * input must be canonicalisable (integers only, up to 2^53-1); the server answers a typed 400 otherwise. Needs `projectSlug` on the client.
     * A long input is scored in overlapping windows and the highest injection score decides.
     * Errors: 413 `K9O_RAMPART_INPUT_TOO_LONG` (past 16 windows, about 6,000 tokens; no verdict), 503
     * `K9O_RAMPART_CLASSIFIER_UNAVAILABLE` (the classifier could not answer; no verdict), 403/404 (not a project
     * member). All arrive as `KError`.
     */
    async classify(input: Record<string, unknown>, options: RampartClassifyOptions = {}): Promise<Envelope<RampartVerdict>> {
      const path = projectPath(t, "rampart.classify", "rampart/classify");
      if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalidField("rampart.classify: input must be a JSON object");
      const label = options.label;
      if (label !== undefined && (typeof label !== "string" || label.length < 1 || label.length > 128)) {
        throw invalidField("rampart.classify: label must be 1 to 128 characters");
      }
      return t.request<RampartVerdict>("POST", path, { body: { input, ...(label !== undefined ? { label } : {}) } });
    },

    /**
     * The public keys that verify receipts and the issuer they carry: `{ keys: [...], issuer? }`, one JWK per `kid`.
     * `issuer` is absent when the gateway does not advertise one. The feed is also kept for `verifyReceipt`.
     */
    jwks,

    /**
     * Check a receipt against the `input` you classified and return its verified claims. Pass the classify result (it
     * carries the receipt and its `projectId`) or a bare receipt string (then also pass `options.projectId`). Throws `RampartReceiptError`
     * (see {@link RampartReceiptReason}) on any failure. Keys come from `options.keys` or the SDK fetches the feed
     * once and keeps it for the life of the client, fetching again once when a `kid` is not in it. The signature is
     * checked with an in-library Ed25519 verifier (React Native's Hermes has no WebCrypto).
     */
    async verifyReceipt(result: string | RampartClassifyResult, input: unknown, options: RampartVerifyOptions = {}): Promise<RampartVerified> {
      let receipt: unknown = result;
      let carriedProjectId: unknown;
      if (typeof result === "object" && result !== null) {
        const v = (typeof (result as Envelope<RampartVerdict>).data === "object" && (result as Envelope<RampartVerdict>).data !== null ? (result as Envelope<RampartVerdict>).data : result) as RampartVerdict;
        receipt = v.classificationReceipt;
        carriedProjectId = v.projectId;
      }
      if (typeof receipt !== "string") throw new RampartReceiptError("malformed", "the receipt is not a string");
      const parts = receipt.split(".");
      if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw new RampartReceiptError("malformed", "a receipt has three dot-separated parts");
      const [h, p, s] = parts as [string, string, string];
      const header = b64urlJson(h, "header");
      const claims = b64urlJson(p, "payload");
      const signature = b64urlDecode(s);
      if (header["crit"] !== undefined || header["b64"] === false) throw new RampartReceiptError("malformed", "the header carries unsupported critical parameters");

      // 1. The key is chosen by the header kid, from the feed; a key inside the receipt is never used.
      if (typeof header["kid"] !== "string") throw new RampartReceiptError("malformed", "the header has no kid");
      const { jwk, issuer: feedIssuer } = await keyFor(header["kid"], options.keys);
      // 2. and 3. Algorithm and type.
      if (header["alg"] !== "EdDSA") throw new RampartReceiptError("alg", "the algorithm is not EdDSA");
      if (header["typ"] !== RAMPART_RECEIPT_TYP) throw new RampartReceiptError("typ", `the type is not ${RAMPART_RECEIPT_TYP}`);
      // Signature, before any claim is trusted.
      const pub = keyBytes(jwk);
      let good = false;
      try {
        good = signature.length === 64 && ed25519Verify(pub, utf8Encode(`${h}.${p}`), signature);
      } catch {
        good = false;
      }
      if (!good) throw new RampartReceiptError("signature", "the signature does not verify");

      // 4. Issuer, project, time window.
      const issuer = options.issuer ?? feedIssuer;
      if (issuer === undefined) throw new RampartReceiptError("issuer", "no issuer is advertised: the key feed carries none and no issuer option was given");
      if (claims["iss"] !== issuer) throw new RampartReceiptError("issuer", "the issuer is not the expected one");
      const expectedProject = options.projectId ?? (typeof carriedProjectId === "string" && carriedProjectId.length > 0 ? carriedProjectId : undefined);
      if (expectedProject === undefined) throw new RampartReceiptError("project_unknown", "no project id to compare: pass the classify result or options.projectId");
      if (claims["project_id"] !== expectedProject) throw new RampartReceiptError("project", "the receipt names a different project");
      const iat = claims["iat"];
      const exp = claims["exp"];
      if (typeof iat !== "number" || typeof exp !== "number" || !isFinite(iat) || !isFinite(exp)) {
        throw new RampartReceiptError("malformed", "iat and exp must be numbers");
      }
      const skew = options.clockSkewSeconds ?? 60;
      const nowSec = (options.now?.() ?? new Date()).getTime() / 1000;
      if (nowSec > exp + skew) throw new RampartReceiptError("expired", "the receipt has expired");
      if (nowSec < iat - skew) throw new RampartReceiptError("not_yet_valid", "the receipt was issued in the future");

      // 5. The receipt must attest this exact input.
      let digest: string;
      try {
        digest = sha256Hex(canonicalize(input));
      } catch (e) {
        throw new RampartReceiptError("input_hash", `the input cannot be canonicalised: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (typeof claims["input_sha256"] !== "string") throw new RampartReceiptError("malformed", "input_sha256 is missing");
      if (claims["input_sha256"] !== digest) throw new RampartReceiptError("input_hash", "the receipt does not attest this input");

      // 6. The verdict comes from the verified claims.
      const c = claims["classification"];
      const cats = claims["categories"];
      if (c !== "clear" && c !== "suspicious" && c !== "malicious") throw new RampartReceiptError("malformed", "unknown classification");
      if (!isBp(claims["risk_bp"]) || !isBp(claims["confidence_bp"])) throw new RampartReceiptError("malformed", "risk_bp and confidence_bp must be integers 0 to 10000");
      if (!Array.isArray(cats) || !cats.every((x) => typeof x === "string")) throw new RampartReceiptError("malformed", "categories must be a list of strings");
      if (typeof claims["calibration_version"] !== "string") throw new RampartReceiptError("malformed", "calibration_version is missing");
      // `windows` is how many windows were scored; other claims the SDK does not know are ignored.
      const w = claims["windows"];
      if (w !== undefined && !(typeof w === "number" && Math.floor(w) === w && w >= 1)) throw new RampartReceiptError("malformed", "windows must be a positive integer");
      return {
        classification: c,
        riskScore: claims["risk_bp"],
        confidence: claims["confidence_bp"],
        categories: cats as string[],
        calibrationVersion: claims["calibration_version"],
        projectId: expectedProject,
        inputSha256: digest,
        issuer,
        windows: w === undefined ? 1 : (w as number),
        issuedAt: iat,
        expiresAt: exp,
        kid: header["kid"],
      };
    },
  };
}

export type RampartNamespace = ReturnType<typeof makeRampartNamespace>;
