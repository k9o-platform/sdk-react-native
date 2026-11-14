/** UTF-8 in plain TypeScript. Hermes has no guaranteed TextEncoder/TextDecoder, so the SDK carries its own. */

/** UTF-8 bytes of `s`. An unpaired surrogate becomes U+FFFD, as TextEncoder does. */
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** Strict UTF-8 decode: returns null for any malformed sequence (overlong, surrogate, out of range, truncated). */
export function utf8DecodeStrict(b: Uint8Array): string | null {
  let s = "";
  let i = 0;
  while (i < b.length) {
    const c = b[i]!;
    let cp: number;
    let n: number;
    let min: number;
    if (c < 0x80) { cp = c; n = 0; min = 0; }
    else if (c >= 0xc2 && c <= 0xdf) { cp = c & 0x1f; n = 1; min = 0x80; }
    else if (c >= 0xe0 && c <= 0xef) { cp = c & 0x0f; n = 2; min = 0x800; }
    else if (c >= 0xf0 && c <= 0xf4) { cp = c & 0x07; n = 3; min = 0x10000; }
    else return null;
    if (i + n >= b.length) return null;
    for (let k = 1; k <= n; k++) {
      const x = b[i + k]!;
      if ((x & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (x & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    s += String.fromCodePoint(cp);
    i += n + 1;
  }
  return s;
}
