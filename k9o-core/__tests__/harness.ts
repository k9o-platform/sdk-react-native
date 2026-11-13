import { CoreClient, type FetchLike } from "../src";

export type Call = { url: URL; raw: string; method: string; headers: Record<string, string>; body: unknown; signal: AbortSignal | undefined };

/** A CoreClient whose fetch records every call and answers with `respond` (default: a one-row envelope). */
export function harness(respond?: (call: Call, n: number) => Response | Promise<Response>, slug: string | null = "demo") {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = init?.body;
    calls.push({
      url: new URL(url),
      raw: url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: typeof body === "string" ? JSON.parse(body) : body,
      signal: init?.signal,
    });
    if (respond) return respond(calls[calls.length - 1]!, calls.length);
    return json({ data: [{ id: "u1" }], meta: { rawQuery: { intent: "read", rowCount: 1 } } });
  };
  const c = new CoreClient({ baseUrl: "https://acme.api-de01.k9o.io", projectSlug: slug ?? undefined, accessToken: "tok", fetch });
  return { c, calls };
}

export const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
