import { describe, expect, test } from "bun:test";
import { CoreClient, type FetchLike } from "../src";

const ok = () => new Response(JSON.stringify({ data: [], meta: {} }), { status: 200, headers: { "content-type": "application/json" } });

function rig(baseUrl: string, probe: (n: number) => Response | Promise<Response>) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  let probes = 0;
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, headers: init?.headers ?? {} });
    if (method === "HEAD") return probe(++probes);
    return ok();
  };
  return { c: new CoreClient({ baseUrl, projectSlug: "demo", accessToken: "secret-tok", fetch }), calls };
}

const redirect = (loc: string) => new Response(null, { status: 308, headers: { location: loc } });

describe("regional host", () => {
  test("region-free address: one credential-free probe, then every request goes to the regional host", async () => {
    const { c, calls } = rig("https://acme.api-staging.k9o.io", () => redirect("https://acme.api-staging-de01.k9o.io/"));
    await c.query("select 1");
    await c.query("select 2");
    expect(calls[0]!.method + " " + calls[0]!.url).toBe("HEAD https://acme.api-staging.k9o.io/");
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
    expect(calls.filter((x) => x.method === "HEAD").length).toBe(1);
    expect(calls[1]!.url.startsWith("https://acme.api-staging-de01.k9o.io/")).toBe(true);
    expect(calls[2]!.url.startsWith("https://acme.api-staging-de01.k9o.io/")).toBe(true);
    expect(calls[1]!.headers["authorization"]).toBe("Bearer secret-tok");
  });

  test("already-regional address: no probe", async () => {
    const { c, calls } = rig("https://acme.api-de01.k9o.io", () => redirect("https://evil.example/"));
    await c.query("select 1");
    expect(calls.map((x) => x.method)).toEqual(["POST"]);
    expect(calls[0]!.url.startsWith("https://acme.api-de01.k9o.io/")).toBe(true);
  });

  test("a redirect to another org or host is ignored; the configured address stays", async () => {
    const { c, calls } = rig("https://acme.api.k9o.io", () => redirect("https://evil.example/"));
    await c.query("select 1");
    expect(calls[1]!.url.startsWith("https://acme.api.k9o.io/")).toBe(true);
  });

  test("a probe network failure is not cached", async () => {
    const { c, calls } = rig("https://acme.api.k9o.io", (n) => {
      if (n === 1) throw new TypeError("offline");
      return redirect("https://acme.api-de01.k9o.io/");
    });
    await c.query("select 1");
    await c.query("select 2");
    expect(calls.filter((x) => x.method === "HEAD").length).toBe(2);
    expect(calls[calls.length - 1]!.url.startsWith("https://acme.api-de01.k9o.io/")).toBe(true);
  });
});

describe("regional host probe failures", () => {
  test("a 5xx probe answer is not cached", async () => {
    const { c, calls } = rig("https://acme.api.k9o.io", (n) => (n === 1 ? new Response("bad gateway", { status: 502 }) : redirect("https://acme.api-de01.k9o.io/")));
    await c.query("select 1");
    await c.query("select 2");
    expect(calls.filter((x) => x.method === "HEAD").length).toBe(2);
    expect(calls[calls.length - 1]!.url.startsWith("https://acme.api-de01.k9o.io/")).toBe(true);
  });
});
