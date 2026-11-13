/**
 * `core.metadata`: columns you declare on a collection so they can be filtered, searched and matched by vector through
 * one API, with the same access rules as the data. There is no `metadata.subscribe`; use `realtime.subscribe`.
 *
 * Declare the columns first (`index.declare`). `set` writes declared columns only; `filter`, `search` and
 * `vectors.nearest` read declared columns only. Column names given to `filter` (`where[].field`), `search` (`field`)
 * and `vectors.nearest` (`column`) are sent as `metadata.<name>`; the prefix is added when you leave it out. Rows come
 * back with bare column names under `metadata`.
 *
 * Errors arrive as `KError` with the gateway's code:
 * - 400 `K9O_UNKNOWN_SURFACE`: the surface is not `collection:<name>`, `telemetry:<event>` or `storage:<bucket>`.
 * - 400 `K9O_METADATA_FIELD_NOT_INDEXED`: the column is not declared.
 * - 400 `K9O_ENCRYPTED_COLUMN_OPERATION_UNSUPPORTED`: an encrypted column takes only `eq` (not null) and `in`.
 * - 403 `K9O_EXTENSION_PERMISSION_DENIED`: an extension token lacks a grant for the surface.
 * - 413 `K9O_QUERY_RESULT_TOO_LARGE`: more than 10000 rows across the surfaces.
 * - 501 `K9O_NOT_IMPLEMENTED`: `storage:` surfaces are accepted by the client and answered with 501.
 */

import type { Envelope } from "./CoreClient";
import { invalidField, projectPath, type Transport } from "./transport";
import { KError } from "./KError";

/** Operators of a `where` clause. `and`, `or` and `not` are in the grammar, but the gateway refuses them today. */
export type MetadataOp =
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "startsWith" | "endsWith" | "in" | "notIn"
  | "and" | "or" | "not";

/**
 * One condition. On a `collection:` surface `field` is a declared column (`priority` or `metadata.priority`) and each
 * field may appear once. On a `telemetry:` surface the fields are `createdAt` (`gt`, `gte`, `lt`, `lte`) and `actorId` (`eq`).
 */
export type MetadataWhere = {
  field: string;
  op: MetadataOp;
  value?: unknown;
};

/** One result row. A `collection:` row has `recordId`; a `telemetry:` row has `eventId`. `metadata` holds the declared columns present on the row. */
export type MetadataRow = {
  surface: string;
  scope: string;
  recordId?: string | undefined;
  eventId?: string | undefined;
  metadata: Record<string, unknown>;
};

/** A page of rows. `cursor` is the cursor of the next page, or `null` when there is none. */
export type MetadataPage = Envelope<MetadataRow[]> & { cursor: string | null };

export type MetadataFilterInput = {
  /** One or more of `collection:<name>`, `telemetry:<event-prefix>`, `storage:<bucket>`. */
  surfaces: ReadonlyArray<string>;
  /** Conditions applied to every surface named. */
  where?: ReadonlyArray<MetadataWhere> | undefined;
  /** Rows per surface, 1 to 1000. The gateway defaults to 100. */
  limit?: number | undefined;
  /** The `cursor` of the previous page. Allowed with exactly one surface. */
  cursor?: string | undefined;
};

export type MetadataSearchInput = {
  /** A `collection:<name>` surface. */
  surface: string;
  /** The declared text column: `body` or `metadata.body`. */
  field: string;
  /** The words to look for. Matching is by word stem, so "finance" does not match "financial". */
  q: string;
  /** 1 to 1000. The gateway defaults to 50. Search has no second page. */
  limit?: number | undefined;
};

export type MetadataMetric = "cosine" | "euclidean" | "dot";

export type MetadataNearestInput = {
  /** A `collection:<name>` surface. */
  surface: string;
  /** The declared vector column: `embedding` or `metadata.embedding`. */
  column: string;
  /** The query embedding: a non-empty array of finite numbers. */
  embedding: ReadonlyArray<number>;
  /** How many rows to return, 1 to 1000. The gateway defaults to 10. */
  k?: number | undefined;
  /** Default `cosine`. */
  metric?: MetadataMetric | undefined;
  /** Conditions rows must also meet; the same grammar as `filter`. */
  where?: ReadonlyArray<MetadataWhere> | undefined;
};

/** The row returned by `set`: the whole updated record, including columns that are not declared. */
export type MetadataRecord = Record<string, unknown>;

export type MetadataIndexColumn = {
  column: string;
  /** Default false. */
  indexed?: boolean | undefined;
};

/** A collection's declaration: its declared columns, ordered by name. */
export type MetadataIndex = {
  collection: string;
  columns: Array<{ column: string; indexed: boolean }>;
};

export type MetadataNamespace = {
  /**
   * Rows of one or more surfaces whose declared columns meet `where`, in request order. Pages with `cursor` when exactly
   * one surface is named (`page.cursor`, `null` on the last page). More than 10000 rows answers 413
   * `K9O_QUERY_RESULT_TOO_LARGE`; a `storage:` surface answers 501 `K9O_NOT_IMPLEMENTED`.
   */
  filter(input: MetadataFilterInput): Promise<MetadataPage>;
  /**
   * Write declared columns of one record. Keys are bare column names (a leading `metadata.` is dropped). Returns the
   * whole updated record. The write follows the record API's rules, so a write that needs approval is queued there.
   */
  set(collection: string, id: string, metadata: Record<string, unknown>): Promise<Envelope<MetadataRecord>>;
  /** Full-text search over one declared text column. First page only (no cursor input), no rank. */
  search(input: MetadataSearchInput): Promise<MetadataPage>;
  vectors: {
    /** Rows whose declared vector column is nearest to `embedding`, closest first. Rows carry no score; at most 50 rows come back whatever `k` is. */
    nearest(input: MetadataNearestInput): Promise<MetadataPage>;
  };
  index: {
    /** The columns declared on a collection, ordered by name. */
    get(collection: string): Promise<Envelope<MetadataIndex>>;
    /** Replace the declaration (an empty list clears it). At most 64 columns, no `id`, no duplicates. Needs the project-admin role and the migrations permission. */
    declare(collection: string, columns: ReadonlyArray<MetadataIndexColumn>): Promise<Envelope<MetadataIndex>>;
  };
};

const OPS: ReadonlyArray<string> = [
  "eq", "neq", "gt", "gte", "lt", "lte", "contains", "startsWith", "endsWith", "in", "notIn", "and", "or", "not",
];
const METRICS: ReadonlyArray<string> = ["cosine", "euclidean", "dot"];
const SLICES: ReadonlyArray<string> = ["collection", "telemetry", "storage"];
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const PREFIX = "metadata.";
const MAX_COLUMNS = 64;
const MAX_LIMIT = 1000;
/** On a telemetry surface these where fields are sent bare. */
const TELEMETRY_FIELDS: ReadonlyArray<string> = ["createdAt", "actorId"];

function sliceOf(surface: string): string {
  return surface.slice(0, surface.indexOf(":"));
}

function checkSurface(surface: unknown, name: string): string {
  if (typeof surface !== "string") throw invalidField(`${name} must be a string such as collection:posts`, { surface });
  const at = surface.indexOf(":");
  const slice = at < 0 ? "" : surface.slice(0, at);
  const scope = at < 0 ? "" : surface.slice(at + 1);
  if (!SLICES.includes(slice) || !SCOPE.test(scope) || (slice === "collection" && !IDENT.test(scope))) {
    throw new KError({
      code: "K9O_UNKNOWN_SURFACE",
      message: `${name} "${surface}" is not a surface: use collection:<name>, telemetry:<event> or storage:<bucket>`,
      context: { surface },
      recommendation: null,
    });
  }
  return surface;
}

function checkCollectionSurface(surface: unknown, name: string): string {
  const s = checkSurface(surface, name);
  if (sliceOf(s) !== "collection") throw invalidField(`${name} must be a collection surface (collection:<name>)`, { surface: s });
  return s;
}

function checkLimit(value: unknown, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_LIMIT)) {
    throw invalidField(`${name} must be a whole number from 1 to ${MAX_LIMIT}`, { [name]: value });
  }
}

/** The name on the wire: `metadata.<name>`, adding the prefix when it is missing. */
function prefixed(name: unknown, label: string): string {
  if (typeof name !== "string" || name.length === 0 || name === PREFIX) throw invalidField(`${label} must be a column name`, { [label]: name });
  return name.startsWith(PREFIX) ? name : `${PREFIX}${name}`;
}

function wireWhere(where: unknown, telemetry: boolean): MetadataWhere[] | undefined {
  if (where === undefined) return undefined;
  if (!Array.isArray(where)) throw invalidField("where must be an array of { field, op, value }");
  return where.map((clause: unknown, index) => {
    if (clause === null || typeof clause !== "object" || Array.isArray(clause)) throw invalidField(`where[${index}] must be an object`);
    const c = clause as MetadataWhere;
    if (typeof c.op !== "string" || !OPS.includes(c.op)) throw invalidField(`where[${index}].op must be one of: ${OPS.join(", ")}`, { op: c.op });
    const bare = telemetry && typeof c.field === "string" && TELEMETRY_FIELDS.includes(c.field);
    return { ...c, field: bare ? c.field : prefixed(c.field, `where[${index}].field`) };
  });
}

export function makeMetadataNamespace(t: Transport): MetadataNamespace {
  const path = (feature: string, tail: string): string => projectPath(t, feature, `metadata/${tail}`);
  const collectionName = (collection: unknown): string => {
    if (typeof collection !== "string" || !IDENT.test(collection)) throw invalidField("collection must be a collection name", { collection });
    return collection;
  };
  const page = (envelope: Envelope<MetadataRow[]>): MetadataPage => {
    const c = (envelope.meta as { cursor?: { next?: unknown } | undefined } | undefined)?.cursor?.next;
    return { ...envelope, cursor: typeof c === "string" ? c : null };
  };

  return {
    async filter(input) {
      const where = path("metadata.filter", "query");
      if (input === null || typeof input !== "object") throw invalidField("input must be an object");
      if (!Array.isArray(input.surfaces) || input.surfaces.length < 1) throw invalidField("surfaces must be a non-empty array");
      const surfaces = input.surfaces.map((s, i) => checkSurface(s, `surfaces[${i}]`));
      checkLimit(input.limit, "limit");
      if (input.cursor !== undefined) {
        if (typeof input.cursor !== "string" || input.cursor.length === 0) throw invalidField("cursor must be the cursor of a previous page");
        if (surfaces.length !== 1) throw invalidField("cursor is allowed only with exactly one surface", { field: "cursor" });
      }
      const wire = wireWhere(input.where, surfaces.some((s) => sliceOf(s) === "telemetry"));
      const body: Record<string, unknown> = { surfaces };
      if (wire !== undefined) body.where = wire;
      if (input.limit !== undefined) body.limit = input.limit;
      if (input.cursor !== undefined) body.cursor = input.cursor;
      return page(await t.request<MetadataRow[]>("POST", where, { body }));
    },

    async set(collection, id, metadata) {
      const name = collectionName(collection);
      if (typeof id !== "string" || id.length === 0) throw invalidField("id must be a record id", { id });
      if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata) || Object.keys(metadata).length === 0) {
        throw invalidField("metadata must be an object with at least one column");
      }
      const bare: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(metadata)) bare[key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key] = value;
      return t.request<MetadataRecord>("PATCH", path("metadata.set", `collection/${encodeURIComponent(name)}/${encodeURIComponent(id)}`), {
        body: { metadata: bare },
      });
    },

    async search(input) {
      const where = path("metadata.search", "search");
      if (input === null || typeof input !== "object") throw invalidField("input must be an object");
      const surface = checkCollectionSurface(input.surface, "surface");
      const field = prefixed(input.field, "field");
      if (typeof input.q !== "string" || input.q.length === 0) throw invalidField("q must be a non-empty string");
      checkLimit(input.limit, "limit");
      const body: Record<string, unknown> = { surface, field, q: input.q };
      if (input.limit !== undefined) body.limit = input.limit;
      return page(await t.request<MetadataRow[]>("POST", where, { body }));
    },

    vectors: {
      async nearest(input) {
        const where = path("metadata.vectors.nearest", "vectors/nearest");
        if (input === null || typeof input !== "object") throw invalidField("input must be an object");
        const surface = checkCollectionSurface(input.surface, "surface");
        const column = prefixed(input.column, "column");
        if (!Array.isArray(input.embedding) || input.embedding.length < 1) throw invalidField("embedding must be a non-empty array of numbers");
        if (!input.embedding.every((n) => typeof n === "number" && Number.isFinite(n))) throw invalidField("embedding must contain only finite numbers");
        checkLimit(input.k, "k");
        if (input.metric !== undefined && !METRICS.includes(input.metric)) {
          throw invalidField(`metric must be one of: ${METRICS.join(", ")}`, { metric: input.metric });
        }
        const wire = wireWhere(input.where, false);
        const body: Record<string, unknown> = { surface, column, embedding: [...input.embedding] };
        if (input.k !== undefined) body.k = input.k;
        if (input.metric !== undefined) body.metric = input.metric;
        if (wire !== undefined) body.where = wire;
        return page(await t.request<MetadataRow[]>("POST", where, { body }));
      },
    },

    index: {
      async get(collection) {
        const name = collectionName(collection);
        return t.request<MetadataIndex>("GET", path("metadata.index.get", `index/${encodeURIComponent(name)}`));
      },

      async declare(collection, columns) {
        const where = path("metadata.index.declare", `index/${encodeURIComponent(collectionName(collection))}`);
        if (!Array.isArray(columns)) throw invalidField("columns must be an array of { column, indexed? }");
        if (columns.length > MAX_COLUMNS) throw invalidField(`at most ${MAX_COLUMNS} columns can be declared`, { count: columns.length });
        const seen = new Set<string>();
        columns.forEach((c, index) => {
          if (c === null || typeof c !== "object") throw invalidField(`columns[${index}] must be an object`);
          if (typeof c.column !== "string" || !IDENT.test(c.column) || c.column === "id") {
            throw invalidField(`columns[${index}].column must be a column name other than id`, { column: c.column });
          }
          if (c.indexed !== undefined && typeof c.indexed !== "boolean") throw invalidField(`columns[${index}].indexed must be true or false`);
          if (seen.has(c.column)) throw invalidField(`column "${c.column}" is listed twice`, { column: c.column });
          seen.add(c.column);
        });
        return t.request<MetadataIndex>("PUT", where, { body: { columns } });
      },
    },
  };
}
