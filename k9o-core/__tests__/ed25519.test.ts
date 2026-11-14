import { describe, expect, it } from "bun:test";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { ed25519Verify } from "../src/ed25519";
import { sha512 } from "../src/sha512";
import { utf8DecodeStrict, utf8Encode } from "../src/utf8";

const hex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// RFC 8032 section 7.1 test vectors 1 to 3 (secret seed, message, signature; the public key is derived and, for vectors 1 and 2, checked against the RFC).
const RFC: Array<{ seed: string; pk?: string; msg: string; sig: string }> = [
  {
    seed: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    pk: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    msg: "",
    sig: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  },
  {
    seed: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
    pk: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    msg: "72",
    sig: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  },
  {
    seed: "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
    msg: "af82",
    sig: "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
  },
];

describe("ed25519Verify: RFC 8032 vectors", () => {
  for (const [i, v] of RFC.entries()) {
    it(`accepts vector ${i + 1} and rejects it with the message changed`, () => {
      const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(v.seed, "hex")]), format: "der", type: "pkcs8" });
      const pk = new Uint8Array(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(12));
      if (v.pk !== undefined) expect(toHex(pk)).toBe(v.pk);
      const msg = hex(v.msg);
      expect(toHex(new Uint8Array(nodeSign(null, msg, key)))).toBe(v.sig); // the signature is the RFC's
      expect(ed25519Verify(pk, msg, hex(v.sig))).toBe(true);
      expect(ed25519Verify(pk, Uint8Array.from([...msg, 0]), hex(v.sig))).toBe(false);
    });
  }
});

describe("ed25519Verify: agreement with node:crypto and refusals", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pk = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(12));
  const msg = utf8Encode("a receipt signing input \u{1f600}");
  const sig = new Uint8Array(nodeSign(null, msg, privateKey));

  it("accepts random signatures made by node", () => {
    expect(ed25519Verify(pk, msg, sig)).toBe(true);
    for (let n = 0; n < 5; n++) {
      const k = generateKeyPairSync("ed25519");
      const p = new Uint8Array(k.publicKey.export({ format: "der", type: "spki" }).subarray(12));
      const m = new Uint8Array(n * 37).map((_, j) => (j * 7 + n) & 255);
      expect(ed25519Verify(p, m, new Uint8Array(nodeSign(null, m, k.privateKey)))).toBe(true);
    }
  });

  it("rejects a flipped bit in the message, in R, in S and in the key, and other lengths", () => {
    expect(ed25519Verify(pk, utf8Encode("another"), sig)).toBe(false);
    for (const at of [0, 31, 32, 40, 63]) {
      const t = sig.slice();
      t[at] = t[at]! ^ 1;
      expect(ed25519Verify(pk, msg, t)).toBe(false);
    }
    const k2 = pk.slice();
    k2[5] = k2[5]! ^ 1;
    expect(ed25519Verify(k2, msg, sig)).toBe(false);
    expect(ed25519Verify(pk, msg, sig.subarray(0, 63))).toBe(false);
    expect(ed25519Verify(pk.subarray(0, 31), msg, sig)).toBe(false);
  });

  it("rejects a non-canonical S (S + L) that the equation alone would accept", () => {
    const L = (1n << 252n) + 27742317777372353535851937790883648493n;
    let s = 0n;
    for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i]!);
    const big = s + L;
    const t = sig.slice();
    for (let i = 0; i < 32; i++) t[32 + i] = Number((big >> BigInt(8 * i)) & 255n);
    expect(big < 1n << 256n).toBe(true);
    expect(ed25519Verify(pk, msg, t)).toBe(false);
  });

  it("rejects a key or R that is not a curve point (y not on the curve, y >= p)", () => {
    const ff = new Uint8Array(32).fill(0xff);
    expect(ed25519Verify(ff, msg, sig)).toBe(false);
    const badR = sig.slice();
    badR.set(ff, 0);
    expect(ed25519Verify(pk, msg, badR)).toBe(false);
    const notOnCurve = new Uint8Array(32);
    notOnCurve[0] = 2; // y = 2 has no x
    expect(ed25519Verify(notOnCurve, msg, sig)).toBe(false);
  });
});

describe("sha512", () => {
  it("matches node:crypto across the padding boundaries", () => {
    for (const n of [0, 1, 3, 111, 112, 113, 127, 128, 129, 239, 240, 1000]) {
      const b = new Uint8Array(n).map((_, j) => (j * 31 + n) & 255);
      expect(toHex(sha512(b))).toBe(createHash("sha512").update(b).digest("hex"));
    }
    expect(toHex(sha512(utf8Encode("abc")))).toBe("ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f");
  });
});

describe("utf8", () => {
  it("encodes like TextEncoder and decodes strictly", () => {
    for (const s of ["", "abc", "é", "€", "\u{1f600}", "a\u0000b"]) {
      expect(toHex(utf8Encode(s))).toBe(toHex(new TextEncoder().encode(s)));
      expect(utf8DecodeStrict(utf8Encode(s))).toBe(s);
    }
    expect(toHex(utf8Encode("\ud800"))).toBe("efbfbd");
    for (const bad of ["ff", "c0af", "e08080", "eda080", "f4908080", "c2", "e282", "80", "f88880808080"]) {
      expect(utf8DecodeStrict(hex(bad))).toBeNull();
    }
  });
});
