import { describe, expect, test } from "bun:test";
import { KError } from "../src";
import { harness, json } from "./harness";

const ROOT = "/@demo/storage/buckets";
const ok = () => json({ data: null, meta: {} });

describe("core.storage buckets", () => {
  test("listBuckets, getBucket (encoded), createBucket, updateBucket", async () => {
    const { c, calls } = harness(ok);
    await c.storage.listBuckets();
    await c.storage.getBucket("a/b");
    await c.storage.createBucket("avatars", { public: false, fileSizeLimit: 10, allowedMimeTypes: ["image/png"] });
    await c.storage.updateBucket("avatars", { fileSizeLimit: null });
    expect(calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      `GET ${ROOT}`, `GET ${ROOT}/a%2Fb`, `POST ${ROOT}`, `PATCH ${ROOT}/avatars`,
    ]);
    expect(calls[2]!.body).toEqual({ name: "avatars", public: false, fileSizeLimit: 10, allowedMimeTypes: ["image/png"] });
    expect(calls[3]!.body).toEqual({ fileSizeLimit: null });
  });

  test("deleteBucket sends ?empty=true only when asked", async () => {
    const { c, calls } = harness(ok);
    await c.storage.deleteBucket("avatars");
    await c.storage.deleteBucket("avatars", { empty: true });
    await c.storage.deleteBucket("avatars", { empty: false });
    expect(calls.map((x) => x.url.search)).toEqual(["", "?empty=true", ""]);
  });

  test("empty and dot-segment bucket names are refused before any request", async () => {
    const { c, calls } = harness(ok);
    for (const name of ["", ".", ".."]) {
      await expect(c.storage.getBucket(name)).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    }
    expect(calls.length).toBe(0);
  });

  test("no projectSlug rejects with K9O_MISSING_PROJECT_CONTEXT", async () => {
    const { c } = harness(ok, null);
    await expect(c.storage.listBuckets()).rejects.toMatchObject({ code: "K9O_MISSING_PROJECT_CONTEXT" });
  });
});

describe("core.storage.from(bucket)", () => {
  test("upload sends multipart bytes without a JSON content type", async () => {
    const { c, calls } = harness(ok);
    await c.storage.from("avatars").upload("user/a.jpg", new Uint8Array([1, 2, 3]), { contentType: "image/jpeg", upsert: true, metadata: { userId: "u1" } });
    expect([calls[0]!.method, calls[0]!.url.pathname]).toEqual(["POST", `${ROOT}/avatars/objects`]);
    const f = calls[0]!.body as FormData;
    expect(f).toBeInstanceOf(FormData);
    expect(f.get("path")).toBe("user/a.jpg");
    expect(f.get("contentType")).toBe("image/jpeg");
    expect(f.get("upsert")).toBe("true");
    expect(JSON.parse(f.get("metadata") as string)).toEqual({ userId: "u1" });
    const file = f.get("file") as File;
    expect(file.size).toBe(3);
    expect(file.type).toBe("image/jpeg");
    expect(calls[0]!.headers["content-type"]).toBeUndefined();
  });

  test("upload defaults to upsert=false and accepts text", async () => {
    const { c, calls } = harness(ok);
    await c.storage.from("docs").upload("a.txt", "hello");
    const f = calls[0]!.body as FormData;
    expect(f.get("upsert")).toBe("false");
    expect(f.get("contentType")).toBeNull();
    expect((f.get("file") as File).size).toBe(5);
  });

  test("upload accepts a React Native file descriptor ({ uri, name, type })", async () => {
    const { c, calls } = harness(ok);
    // Bun's FormData only takes Blob/string values, so stand in for React Native's descriptor handling.
    const seen: unknown[] = [];
    const orig = FormData.prototype.append;
    FormData.prototype.append = function (this: FormData, name: string, value: unknown, ...rest: unknown[]) {
      if (name === "file") seen.push(value);
      return (orig as (...a: unknown[]) => void).call(this, name, typeof value === "object" && value !== null && "uri" in value ? "stub" : value, ...rest);
    } as typeof orig;
    try {
      await c.storage.from("photos").upload("p/1.jpg", { uri: "file:///tmp/1.jpg", type: "image/jpeg" });
      await c.storage.from("photos").upload("p/2.jpg", { uri: "file:///tmp/2.jpg", name: "two.jpg", type: "image/png" }, { contentType: "image/jpeg" });
    } finally {
      FormData.prototype.append = orig;
    }
    expect(seen[0]).toEqual({ uri: "file:///tmp/1.jpg", name: "1.jpg", type: "image/jpeg" });
    expect(seen[1]).toEqual({ uri: "file:///tmp/2.jpg", name: "two.jpg", type: "image/jpeg" });
    expect(calls.length).toBe(2);
  });

  test("an empty object path is refused before any request", async () => {
    const { c, calls } = harness(ok);
    const h = c.storage.from("avatars");
    await expect(h.upload("", "x")).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    await expect(h.remove("")).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    await expect(h.createSignedUrl("", { expiresIn: 60 })).rejects.toMatchObject({ code: "K9O_INVALID_FIELD_VALUE" });
    expect(calls.length).toBe(0);
  });

  test("createSignedUrl sends { path, expiresIn, download } and requires a valid expiresIn", async () => {
    const { c, calls } = harness(() => json({ data: { signedUrl: "https://x", expiresIn: 300 }, meta: {} }));
    const r = await c.storage.from("avatars").createSignedUrl("a.jpg", { expiresIn: 300, download: true });
    expect([calls[0]!.method, calls[0]!.url.pathname]).toEqual(["POST", `${ROOT}/avatars/objects/sign`]);
    expect(calls[0]!.body).toEqual({ path: "a.jpg", expiresIn: 300, download: true });
    expect(r.data.signedUrl).toBe("https://x");
    await c.storage.from("avatars").createSignedUrl("a.jpg", { expiresIn: 604_800 });
    expect(calls[1]!.body).toEqual({ path: "a.jpg", expiresIn: 604_800 });
    const before = calls.length;
    for (const bad of [undefined, 0, -1, 1.5, 604_801, Number.NaN, "300"]) {
      const err = await c.storage.from("avatars").createSignedUrl("a.jpg", { expiresIn: bad as never }).catch((e) => e);
      expect(err).toBeInstanceOf(KError);
      expect(err.code).toBe("K9O_INVALID_FIELD_VALUE");
    }
    expect(calls.length).toBe(before);
  });

  test("list sends ?prefix= only when given; remove DELETEs ?path=", async () => {
    const { c, calls } = harness(ok);
    await c.storage.from("avatars").list();
    await c.storage.from("avatars").list({ prefix: "user/" });
    await c.storage.from("avatars").remove("user/a b.jpg");
    expect(calls.map((x) => `${x.method} ${x.url.pathname}${x.url.search}`)).toEqual([
      `GET ${ROOT}/avatars/objects`,
      `GET ${ROOT}/avatars/objects?prefix=user%2F`,
      `DELETE ${ROOT}/avatars/objects?path=user%2Fa%20b.jpg`,
    ]);
  });
});
