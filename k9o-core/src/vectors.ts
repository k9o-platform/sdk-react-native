/**
 * `core.vectors`: embeddings you computed yourself, stored next to the text and metadata they came from, and
 * nearest-neighbour search over them. Both calls send the vector in the request body, so they take real embeddings
 * of any common size (up to 16000 numbers).
 *
 * A vector collection's name starts with `_`. The first upsert creates the collection and fixes its dimension; every
 * later vector must have the same length. Searching a collection that was never upserted answers 404
 * `K9O_COLLECTION_NOT_FOUND`.
 */

import type { Envelope } from "./CoreClient";
import { invalidField, projectPath, type Transport } from "./transport";

export type VectorMetric = "cosine" | "euclidean" | "dot";

/** Where a vector came from: a source handle and the index of the chunk within it. */
export type VectorSource = {
  handle: string;
  chunkIndex: number;
  [key: string]: unknown;
};

/** Equality filters: a path (`id`, `contentHash`, `source.<key>` or `metadata.<key>`) and the value it must equal. */
export type VectorFilters = Record<string, string | number | boolean>;

export type NearestVectorsInput = {
  /** The embedding to search with: 1 to 16000 numbers, the same length as the stored vectors. */
  queryVector: ReadonlyArray<number>;
  /** How many results to return, 1 to 1000. The gateway defaults to 10. */
  topK?: number | undefined;
  /** Keep only results whose `score` is at least this. Default: no threshold. */
  minScore?: number | undefined;
  /** Default `cosine`. */
  metric?: VectorMetric | undefined;
  /** Equality filters on `id`, `contentHash`, `source.<key>` and `metadata.<key>`; every one must match. */
  filters?: VectorFilters | undefined;
};

export type NearestVector = {
  id: string;
  /** Higher is more similar. `cosine`: 1 minus the distance; `euclidean`: 1 / (1 + distance); `dot`: the inner product. */
  score: number;
  _source: VectorSource;
  contentHash: string | null;
  text: string | null;
  metadata: Record<string, unknown>;
  /** From `metadata.model`, when set. */
  model: string | null;
  /** From `_source.chunkIndex`, when set. */
  chunk: number | null;
};

export type NearestVectorsResult = {
  /** Closest first. */
  results: NearestVector[];
  collection: string;
};

export type VectorRow = {
  /** 1 to 256 characters. Default: generated. Upserting an existing id overwrites that row. */
  id?: string | undefined;
  /** 1 to 16000 numbers; every row in one request has the same length. */
  vector: ReadonlyArray<number>;
  _source: VectorSource;
  /** At most 128 characters. */
  contentHash?: string | undefined;
  /** At most 100000 characters. Stored sealed when the row belongs to a subject. */
  text?: string | undefined;
  /** Default `{}`. Only keep values here that you filter on; they are stored in plain text. */
  metadata?: Record<string, unknown> | undefined;
  /**
   * The one end user the row belongs to (`["eu_..."]`). Required on a per-subject collection (the default for a new
   * collection); refused on a collection declared shared.
   */
  subjectIds?: ReadonlyArray<string> | undefined;
};

export type UpsertVectorsResult = {
  upserted: number;
  collection: string;
};

export type VectorsNamespace = {
  /** The rows nearest to `queryVector`, closest first. Answers 404 when the collection has never been upserted. */
  nearest(collection: string, input: NearestVectorsInput): Promise<Envelope<NearestVectorsResult>>;
  /** Insert or overwrite 1 to 1000 rows in one request. The first upsert creates the collection. */
  upsert(collection: string, rows: ReadonlyArray<VectorRow>): Promise<Envelope<UpsertVectorsResult>>;
};

const METRICS: ReadonlyArray<string> = ["cosine", "euclidean", "dot"];
const MAX_VECTOR = 16000;
const MAX_ROWS = 1000;

function checkVector(vector: unknown, name: string): void {
  if (!Array.isArray(vector) || vector.length < 1 || vector.length > MAX_VECTOR) {
    throw invalidField(`${name} must be an array of 1 to ${MAX_VECTOR} numbers`);
  }
  if (!vector.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw invalidField(`${name} must contain only finite numbers`);
  }
}

export function makeVectorsNamespace(t: Transport): VectorsNamespace {
  const path = (feature: string, collection: unknown, tail: string): string => {
    if (typeof collection !== "string" || !collection.startsWith("_")) {
      throw invalidField("a vector collection name must start with _", { collection });
    }
    return projectPath(t, feature, `vectors/${encodeURIComponent(collection)}/${tail}`);
  };
  return {
    async nearest(collection, input) {
      const where = path("vectors.nearest", collection, "search");
      if (input === null || typeof input !== "object") throw invalidField("input must be an object");
      checkVector(input.queryVector, "queryVector");
      if (input.topK !== undefined && (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 1000)) {
        throw invalidField("topK must be a whole number from 1 to 1000", { topK: input.topK });
      }
      if (input.minScore !== undefined && (typeof input.minScore !== "number" || !Number.isFinite(input.minScore))) {
        throw invalidField("minScore must be a number", { minScore: input.minScore });
      }
      if (input.metric !== undefined && !METRICS.includes(input.metric)) {
        throw invalidField(`metric must be one of: ${METRICS.join(", ")}`, { metric: input.metric });
      }
      if (input.filters !== undefined && (input.filters === null || typeof input.filters !== "object" || Array.isArray(input.filters))) {
        throw invalidField("filters must be an object of path to value");
      }
      const body: Record<string, unknown> = { queryVector: [...input.queryVector] };
      if (input.topK !== undefined) body.topK = input.topK;
      if (input.minScore !== undefined) body.minScore = input.minScore;
      if (input.metric !== undefined) body.metric = input.metric;
      if (input.filters !== undefined) body.filters = input.filters;
      return t.request<NearestVectorsResult>("POST", where, { body });
    },

    async upsert(collection, rows) {
      const where = path("vectors.upsert", collection, "upsert");
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS) {
        throw invalidField(`rows must be an array of 1 to ${MAX_ROWS} rows`);
      }
      rows.forEach((row, index) => {
        if (row === null || typeof row !== "object") throw invalidField(`rows[${index}] must be an object`);
        checkVector(row.vector, `rows[${index}].vector`);
      });
      return t.request<UpsertVectorsResult>("POST", where, { body: { rows } });
    },
  };
}
