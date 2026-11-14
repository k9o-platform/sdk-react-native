/** Server-Sent Events frame parser (internal). */

function indexOfEventBoundary(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

/** One SSE frame with its control fields. */
export type SseFrame = {
  /** The `id:` field, when the frame has one. */
  id?: string;
  /** The `event:` field, when the frame has one. */
  event?: string;
  /** The assembled `data:` text, or null for a frame that carries none (a comment, a `retry:` hint). */
  data: string | null;
  /** The `retry:` hint in milliseconds, when the frame carries a valid one. */
  retry?: number;
};

/**
 * Parse an SSE byte stream into frames, keeping `id:`, `event:` and `retry:` (which `parseSseStream` drops). Frames are
 * separated by a blank line; comment lines are ignored. A trailing frame without its blank line is still returned.
 */
export async function* parseSseFrames(response: Response, opts: { onChunk?: () => void } = {}): AsyncGenerator<SseFrame, void, void> {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (body == null || typeof body.getReader !== "function") {
    // This fetch does not stream response bodies: read the whole body and parse what the connection delivered.
    let buffer = await response.text();
    let sep: number;
    while ((sep = indexOfEventBoundary(buffer)) !== -1) {
      const frame = frameFrom(buffer.slice(0, sep));
      buffer = buffer.slice(sep).replace(/^(\r?\n)+/, "");
      if (frame !== null) yield frame;
    }
    const rest = buffer.trim();
    if (rest.length > 0) {
      const frame = frameFrom(rest);
      if (frame !== null) yield frame;
    }
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      opts.onChunk?.();
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = indexOfEventBoundary(buffer)) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n)+/, "");
        const frame = frameFrom(raw);
        if (frame !== null) yield frame;
      }
    }
    const tail = buffer.trim();
    if (tail.length > 0) {
      const frame = frameFrom(tail);
      if (frame !== null) yield frame;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    reader.releaseLock();
  }
}

function frameFrom(raw: string): SseFrame | null {
  const frame: SseFrame = { data: null };
  const data: string[] = [];
  let seen = false;
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const val = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") data.push(val);
    else if (field === "id") frame.id = val;
    else if (field === "event") frame.event = val;
    else if (field === "retry" && /^[0-9]+$/.test(val)) frame.retry = Number(val);
    else continue;
    seen = true;
  }
  if (!seen) return null;
  if (data.length > 0) frame.data = data.join("\n");
  return frame;
}
