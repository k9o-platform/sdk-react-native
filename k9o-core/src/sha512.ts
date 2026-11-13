/**
 * SHA-512 (FIPS 180-4) in plain TypeScript with BigInt, for Ed25519 verification. The round constants are derived
 * at first use from their definition (fractional parts of the square and cube roots of the first primes) rather
 * than typed in, and the tests check the digest against known vectors and a reference implementation.
 */

const M64 = (1n << 64n) - 1n;

function iroot(n: bigint, k: bigint): bigint {
  // floor(n^(1/k)) by Newton iteration
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / Number(k)) + 1);
  for (;;) {
    const y = ((k - 1n) * x + n / x ** (k - 1n)) / k;
    if (y >= x) return x;
    x = y;
  }
}

function primes(count: number): bigint[] {
  const out: bigint[] = [];
  for (let c = 2; out.length < count; c++) {
    let ok = true;
    for (let d = 2; d * d <= c; d++) if (c % d === 0) { ok = false; break; }
    if (ok) out.push(BigInt(c));
  }
  return out;
}

let K: bigint[] | undefined;
let H0: bigint[] | undefined;

function init(): void {
  if (K !== undefined) return;
  const p = primes(80);
  K = p.map((q) => iroot(q << 192n, 3n) & M64);
  H0 = p.slice(0, 8).map((q) => iroot(q << 128n, 2n) & M64);
}

const rotr = (x: bigint, n: bigint): bigint => ((x >> n) | (x << (64n - n))) & M64;

/** SHA-512 digest of `data` (64 bytes). */
export function sha512(data: Uint8Array): Uint8Array {
  init();
  const k = K!;
  const h = H0!.slice();
  const total = ((data.length + 17 + 127) >> 7) << 7;
  const padded = new Uint8Array(total);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(total - 8, Math.floor((data.length * 8) / 0x100000000));
  view.setUint32(total - 4, (data.length * 8) >>> 0);
  const w: bigint[] = new Array<bigint>(80).fill(0n);
  for (let off = 0; off < total; off += 128) {
    for (let i = 0; i < 16; i++) w[i] = (BigInt(view.getUint32(off + i * 8)) << 32n) | BigInt(view.getUint32(off + i * 8 + 4));
    for (let i = 16; i < 80; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(w15, 1n) ^ rotr(w15, 8n) ^ (w15 >> 7n);
      const s1 = rotr(w2, 19n) ^ rotr(w2, 61n) ^ (w2 >> 6n);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) & M64;
    }
    let [a, b, c, d, e, f, g, hh] = h as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
    for (let i = 0; i < 80; i++) {
      const t1 = (hh + (rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n)) + ((e & f) ^ (~e & M64 & g)) + k[i]! + w[i]!) & M64;
      const t2 = ((rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n)) + ((a & b) ^ (a & c) ^ (b & c))) & M64;
      hh = g; g = f; f = e; e = (d + t1) & M64; d = c; c = b; b = a; a = (t1 + t2) & M64;
    }
    const v = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i]! + v[i]!) & M64;
  }
  const out = new Uint8Array(64);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) {
    ov.setUint32(i * 8, Number(h[i]! >> 32n));
    ov.setUint32(i * 8 + 4, Number(h[i]! & 0xffffffffn));
  }
  return out;
}
