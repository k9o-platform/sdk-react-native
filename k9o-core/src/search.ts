import type { Envelope } from "./CoreClient";
import { makeFromFactory, type TextSearchOptions } from "./data";
import type { Transport } from "./transport";

export type SearchInput = TextSearchOptions & {
  /** The text column to search (required). */
  column: string;
  /** The search text. */
  q: string;
  /** Page size. */
  limit?: number;
  /** Opaque cursor from a previous answer's `meta.cursor.next`. */
  cursor?: string;
};

/** `core.search(collection, { column, q })`: full-text search over one text column, best matches first. */
export function makeSearch(t: Transport) {
  const from = makeFromFactory(t);
  return async function search<T = Record<string, unknown>>(
    collection: string,
    input: SearchInput,
  ): Promise<Envelope<ReadonlyArray<T>>> {
    const opts: TextSearchOptions = {};
    if (input.language !== undefined) opts.language = input.language;
    if (input.type !== undefined) opts.type = input.type;
    let builder = from(collection).select<T>().textSearch(input.column, input.q, opts);
    if (input.limit !== undefined) builder = builder.limit(input.limit);
    if (input.cursor !== undefined) builder = builder.cursor(input.cursor);
    return builder;
  };
}
