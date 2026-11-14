/**
 * Ed25519 signature verification (RFC 8032, section 5.1.7) in plain TypeScript with BigInt.
 *
 * React Native's Hermes engine has no WebCrypto, so the SDK verifies receipts with this module. It needs BigInt:
 * Hermes from React Native 0.70, JavaScriptCore from iOS 14 (and Android JSC builds of the same era). It only
 * verifies; it holds no secret, so constant-time behaviour is not needed. A verification takes tens of
 * milliseconds on a phone.
 *
 * `ed25519Verify` is cofactorless: it accepts when `[S]B == R + [h]A`, rejects a non-canonical `S` (`S >= L`) and
 * rejects a public key or `R` that is not a valid point encoding.
 */
import { sha512 } from "./sha512";

const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

function mod(a: bigint): bigint {
  const r = a % P;
  return r >= 0n ? r : r + P;
}

function pow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

const inv = (a: bigint): bigint => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

/** Extended homogeneous coordinates (X, Y, Z, T): x = X/Z, y = Y/Z, x*y = T/Z. */
type Point = readonly [bigint, bigint, bigint, bigint];

function recoverX(y: bigint, sign: bigint): bigint | null {
  if (y >= P) return null;
  const x2 = mod((y * y - 1n) * inv(D * y * y + 1n));
  if (x2 === 0n) return sign ? null : 0n;
  let x = pow(x2, (P + 3n) / 8n);
  if (mod(x * x - x2) !== 0n) x = mod(x * SQRT_M1);
  if (mod(x * x - x2) !== 0n) return null;
  if ((x & 1n) !== sign) x = P - x;
  return x;
}

const BY = mod(4n * inv(5n));
const BX = recoverX(BY, 0n)!;
const BASE: Point = [BX, BY, 1n, mod(BX * BY)];
const IDENTITY: Point = [0n, 1n, 1n, 0n];

function add(a: Point, b: Point): Point {
  const a1 = mod((a[1] - a[0]) * (b[1] - b[0]));
  const b1 = mod((a[1] + a[0]) * (b[1] + b[0]));
  const c1 = mod(2n * a[3] * b[3] * D);
  const d1 = mod(2n * a[2] * b[2]);
  const e = b1 - a1;
  const f = d1 - c1;
  const g = d1 + c1;
  const h = b1 + a1;
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}

function mul(scalar: bigint, point: Point): Point {
  let result = IDENTITY;
  let addend = point;
  let s = scalar;
  while (s > 0n) {
    if (s & 1n) result = add(result, addend);
    addend = add(addend, addend);
    s >>= 1n;
  }
  return result;
}

function equal(a: Point, b: Point): boolean {
  return mod(a[0] * b[2] - b[0] * a[2]) === 0n && mod(a[1] * b[2] - b[1] * a[2]) === 0n;
}

function leToInt(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
}

function decode(enc: Uint8Array): Point | null {
  if (enc.length !== 32) return null;
  let y = leToInt(enc);
  const sign = y >> 255n;
  y &= (1n << 255n) - 1n;
  const x = recoverX(y, sign);
  if (x === null) return null;
  return [x, y, 1n, mod(x * y)];
}

/** True when `signature` (64 bytes) is a valid Ed25519 signature of `message` under `publicKey` (32 bytes). */
export function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const a = decode(publicKey);
  const rBytes = signature.subarray(0, 32);
  const r = decode(rBytes);
  if (a === null || r === null) return false;
  const s = leToInt(signature.subarray(32));
  if (s >= L) return false;
  const buf = new Uint8Array(64 + message.length);
  buf.set(rBytes, 0);
  buf.set(publicKey, 32);
  buf.set(message, 64);
  const h = leToInt(sha512(buf)) % L;
  return equal(mul(s, BASE), add(r, mul(h, a)));
}
