/**
 * Data builder: `core.from(collection)`.
 *
 *   from("notes").select()                       GET    /@<slug>/data/notes
 *   from("notes").select().eq("id", "rec_1")     GET    /@<slug>/data/notes?id=eq.rec_1
 *   from("notes").insert({ ... })                POST   /@<slug>/data/notes
 *   from("notes").update({ ... }).eq("id", ...)  PATCH  /@<slug>/data/notes/<id>
 *   from("notes").delete().eq("id", ...)         DELETE /@<slug>/data/notes/<id>
 *
 * Chain `.requireApproval()` on an insert, update or delete to queue the write for approval instead of applying it.
 *
 * Filters combine with AND. The next page cursor is `meta.cursor.next` of the previous answer.
 */

import type { Envelope } from "./CoreClient";
import { invalidField, projectPath, type QueryString, type Transport } from "./transport";
import { KError } from "./KError";

export type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "notIn" | "like" | "ilike" | "is";
type FilterValue = string | number | boolean | ReadonlyArray<string | number>;
type Filter = { column: string; op: FilterOp; value: FilterValue };

export type TextSearchOptions = {
  /** A text-search configuration name; default "english". */
  language?: string;
  /** `plain` (default), `phrase` or `websearch` query syntax. */
  type?: "plain" | "phrase" | "websearch";
};

export type VectorSearchOptions = {
  /** `cosine` (default), `euclidean` or `dot`. */
  metric?: "cosine" | "euclidean" | "dot";
  /** Rows to return, 1 to 1000 (default 10). Results come back closest first. */
  limit?: number;
};

const SEARCH_COLUMN = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const COLLECTION = /^[a-z][a-z0-9_-]{0,62}$/;

class QueryBuilder {
  protected filters: Filter[] = [];
  protected limitVal: number | undefined;
  protected cursorVal: string | undefined;
  protected countMode: "none" | "exact" | "estimated" | undefined;

  eq(column: string, value: string | number | boolean): this { return this.add(column, "eq", value); }
  neq(column: string, value: string | number | boolean): this { return this.add(column, "neq", value); }
  gt(column: string, value: string | number): this { return this.add(column, "gt", value); }
  gte(column: string, value: string | number): this { return this.add(column, "gte", value); }
  lt(column: string, value: string | number): this { return this.add(column, "lt", value); }
  lte(column: string, value: string | number): this { return this.add(column, "lte", value); }
  in(column: string, values: ReadonlyArray<string | number>): this { return this.add(column, "in", values); }
  notIn(column: string, values: ReadonlyArray<string | number>): this { return this.add(column, "notIn", values); }
  like(column: string, pattern: string): this { return this.add(column, "like", pattern); }
  ilike(column: string, pattern: string): this { return this.add(column, "ilike", pattern); }
  is(column: string, value: "null" | "true" | "false"): this { return this.add(column, "is", value); }

  /** Explicit operator form: `.filter("age", "gte", 18)`. */
  filter(column: string, op: FilterOp, value: FilterValue): this { return this.add(column, op, value); }

  /** Page size. */
  limit(n: number): this { this.limitVal = n; return this; }
  /** Opaque cursor from the previous answer's `meta.cursor.next`. */
  cursor(opaque: string): this { this.cursorVal = opaque; return this; }
  /** `none` (default), `exact` or `estimated` total count. */
  count(mode: "none" | "exact" | "estimated"): this { this.countMode = mode; return this; }

  private add(column: string, op: FilterOp, value: FilterValue): this {
    this.filters.push({ column, op, value });
    return this;
  }

  protected toQuery(): QueryString {
    const q: QueryString = {};
    for (const f of this.filters) {
      const val = Array.isArray(f.value) ? `(${(f.value as ReadonlyArray<string | number>).join(",")})` : String(f.value);
      // One filter per column: a later filter on the same column replaces the earlier one.
      q[f.column] = `${f.op}.${val}`;
    }
    if (this.limitVal !== undefined) q["limit"] = this.limitVal;
    if (this.cursorVal !== undefined) q["cursor"] = this.cursorVal;
    if (this.countMode !== undefined) q["count"] = this.countMode;
    return q;
  }
}

function collectionPath(t: Transport, collection: string): string {
  const path = projectPath(t, "data operations", `data/${collection}`);
  if (!COLLECTION.test(collection)) {
    throw new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `collection name "${collection}" does not match required format`,
      context: { collection },
      recommendation: "Use lowercase letters, digits, underscores and hyphens; start with a letter; 1 to 63 characters.",
    });
  }
  return path;
}

function idOf(filters: Filter[], verb: string, collection: string): string {
  const f = filters.find((x) => x.column === "id" && x.op === "eq");
  if (f === undefined) {
    throw new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `${verb}() requires an .eq('id', '...') filter; changing many rows in one call is not supported`,
      context: { collection },
      recommendation: `Chain .eq('id', 'rec_…') before awaiting the ${verb}; for several rows, call ${verb} once per id.`,
    });
  }
  return encodeURIComponent(String(f.value));
}

export class SelectBuilder<T> extends QueryBuilder implements PromiseLike<Envelope<ReadonlyArray<T>>> {
  private searchQuery: Record<string, string> = {};
  private vectorBody: { column: string; vector: ReadonlyArray<number>; metric?: string; limit?: number } | undefined;

  constructor(private readonly t: Transport, private readonly collection: string) {
    super();
  }

  /** Full-text search over one text column. Composes with filters, `limit` and `cursor`. */
  textSearch(column: string, query: string, options: TextSearchOptions = {}): this {
    if (!SEARCH_COLUMN.test(column)) throw invalidField(`textSearch column '${column}' is not a valid identifier`);
    if (typeof query !== "string" || query.length === 0) throw invalidField("textSearch query must be non-empty");
    const language = options.language ?? "english";
    if (!/^[a-zA-Z_]+$/.test(language)) throw invalidField("textSearch language must be a text-search configuration name");
    const type = options.type ?? "plain";
    if (type !== "plain" && type !== "phrase" && type !== "websearch") {
      throw invalidField("textSearch type must be plain, phrase or websearch");
    }
    this.searchQuery["textSearch"] = `${column}:${query}`;
    if (language !== "english") this.searchQuery["textSearchLanguage"] = language;
    else delete this.searchQuery["textSearchLanguage"];
    if (type !== "plain") this.searchQuery["textSearchType"] = type;
    else delete this.searchQuery["textSearchType"];
    return this;
  }

  /** Semantic search: the rows nearest to an embedding in one vector column, closest first. */
  vectorSearch(column: string, embedding: ReadonlyArray<number>, options: VectorSearchOptions = {}): this {
    if (!SEARCH_COLUMN.test(column)) throw invalidField(`vectorSearch column '${column}' is not a valid identifier`);
    if (!Array.isArray(embedding) || embedding.length === 0 || embedding.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
      throw invalidField("vectorSearch embedding must be a non-empty array of numbers");
    }
    const metric = options.metric ?? "cosine";
    if (metric !== "cosine" && metric !== "euclidean" && metric !== "dot") {
      throw invalidField("vectorSearch metric must be cosine, euclidean or dot");
    }
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000)) {
      throw invalidField("vectorSearch limit must be an integer from 1 to 1000");
    }
    this.vectorBody = {
      column,
      vector: [...embedding],
      ...(metric !== "cosine" ? { metric } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    };
    return this;
  }

  protected override toQuery(): QueryString {
    return { ...super.toQuery(), ...this.searchQuery };
  }

  private async exec(): Promise<Envelope<ReadonlyArray<T>>> {
    const path = collectionPath(this.t, this.collection);
    const vector = this.vectorBody;
    if (vector === undefined) {
      return this.t.request<ReadonlyArray<T>>("GET", path, { query: this.toQuery() });
    }
    // The embedding travels in a request body: a real embedding does not fit in a URL.
    if (this.searchQuery["textSearch"] !== undefined) {
      throw invalidField("vectorSearch and textSearch cannot be combined on one query");
    }
    const filter: Record<string, string> = {};
    const body: Record<string, unknown> = { vectorSearch: vector };
    for (const [key, value] of Object.entries(this.toQuery())) {
      if (key === "select" || key === "order" || key === "limit" || key === "cursor" || key === "count" || key === "or") body[key] = value;
      else filter[key] = String(value);
    }
    if (Object.keys(filter).length > 0) body["filter"] = filter;
    return this.t.request<ReadonlyArray<T>>("POST", `${path}/search`, { body });
  }

  then<R1 = Envelope<ReadonlyArray<T>>, R2 = never>(
    onfulfilled?: ((value: Envelope<ReadonlyArray<T>>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.exec().then(onfulfilled, onrejected);
  }
}

/** What a write answers with when it was queued instead of applied (HTTP 202): the change as it was proposed. */
export type QueuedChange = {
  /** `apr_<base62>`. */
  id: string;
  status: "pending_approval";
  collection: string;
  operation: "insert" | "update" | "delete";
  makerId: string;
  /** Insert: the record. Update: the patch. Delete: `{}`. */
  proposedPayload: Record<string, unknown>;
  /** The record the change targets; `null` for an insert. */
  targetRecordId: string | null;
};

/** The envelope of a queued write: `meta.approval.status` repeats `data.status`. */
export type QueuedWrite = {
  data: QueuedChange;
  meta: Record<string, unknown> & { approval: { status: "pending_approval" } };
};

/**
 * Answer of a single-record write sent with `requireApproval()`: the queued change, or the normal envelope of the
 * write when an `auto_approve` policy applied it at once. Tell them apart with {@link isQueuedWrite}.
 */
export type ApprovalGatedWrite<T> = QueuedWrite | Envelope<T>;

/** True when a write was queued for approval (HTTP 202) instead of applied. */
export function isQueuedWrite<T>(result: ApprovalGatedWrite<T>): result is QueuedWrite {
  const approval = (result.meta as { approval?: { status?: unknown } } | undefined)?.approval;
  const data = result.data as { status?: unknown } | null | undefined;
  return approval?.status === "pending_approval" && data !== null && typeof data === "object" && data.status === "pending_approval";
}

type WriteResult<T, Gated extends boolean> = Gated extends true ? ApprovalGatedWrite<T> : Envelope<T>;

/** `{ requireApproval: "true" }` for a write that asks to be queued, no query at all otherwise. */
function approvalQuery(requireApproval: boolean): QueryString | undefined {
  return requireApproval ? { requireApproval: "true" } : undefined;
}

class InsertBuilder<T, Gated extends boolean> implements PromiseLike<WriteResult<T, Gated>> {
  private approval = false;

  constructor(private readonly t: Transport, private readonly collection: string, private readonly record: Partial<T>) {}

  /**
   * Ask for this write to wait for approval (`?requireApproval=true`). The answer is then either the queued change
   * (HTTP 202) or, when an `auto_approve` policy covers the write, the inserted row: narrow with `isQueuedWrite`.
   */
  requireApproval(this: InsertBuilder<T, false>): InsertBuilder<T, true> {
    this.approval = true;
    return this as unknown as InsertBuilder<T, true>;
  }

  private async exec(): Promise<WriteResult<T, Gated>> {
    const query = approvalQuery(this.approval);
    return this.t.request<T>("POST", collectionPath(this.t, this.collection), {
      body: this.record,
      ...(query !== undefined ? { query } : {}),
    }) as unknown as Promise<WriteResult<T, Gated>>;
  }

  then<R1 = WriteResult<T, Gated>, R2 = never>(
    onfulfilled?: ((value: WriteResult<T, Gated>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.exec().then(onfulfilled, onrejected);
  }
}

class UpdateBuilder<T, Gated extends boolean> extends QueryBuilder implements PromiseLike<WriteResult<T, Gated>> {
  private approval = false;

  constructor(private readonly t: Transport, private readonly collection: string, private readonly patch: Partial<T>) {
    super();
  }

  /**
   * Ask for this write to wait for approval (`?requireApproval=true`). The answer is then either the queued change
   * (HTTP 202) or, when an `auto_approve` policy covers the write, the updated row: narrow with `isQueuedWrite`.
   */
  requireApproval(this: UpdateBuilder<T, false>): UpdateBuilder<T, true> {
    this.approval = true;
    return this as unknown as UpdateBuilder<T, true>;
  }

  private async exec(): Promise<WriteResult<T, Gated>> {
    const base = collectionPath(this.t, this.collection);
    const id = idOf(this.filters, "update", this.collection);
    const query = approvalQuery(this.approval);
    return this.t.request<T>("PATCH", `${base}/${id}`, {
      body: this.patch,
      ...(query !== undefined ? { query } : {}),
    }) as unknown as Promise<WriteResult<T, Gated>>;
  }

  then<R1 = WriteResult<T, Gated>, R2 = never>(
    onfulfilled?: ((value: WriteResult<T, Gated>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.exec().then(onfulfilled, onrejected);
  }
}

class DeleteBuilder<T, Gated extends boolean> extends QueryBuilder implements PromiseLike<WriteResult<T, Gated>> {
  private approval = false;

  constructor(private readonly t: Transport, private readonly collection: string) {
    super();
  }

  /**
   * Ask for this delete to wait for approval (`?requireApproval=true`). The answer is then either the queued change
   * (HTTP 202) or, when an `auto_approve` policy covers the write, the deleted record: narrow with `isQueuedWrite`.
   */
  requireApproval(this: DeleteBuilder<T, false>): DeleteBuilder<T, true> {
    this.approval = true;
    return this as unknown as DeleteBuilder<T, true>;
  }

  private async exec(): Promise<WriteResult<T, Gated>> {
    const base = collectionPath(this.t, this.collection);
    const id = idOf(this.filters, "delete", this.collection);
    const query = approvalQuery(this.approval);
    return this.t.request<T>("DELETE", `${base}/${id}`, query !== undefined ? { query } : {}) as unknown as Promise<WriteResult<T, Gated>>;
  }

  then<R1 = WriteResult<T, Gated>, R2 = never>(
    onfulfilled?: ((value: WriteResult<T, Gated>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.exec().then(onfulfilled, onrejected);
  }
}

export class FromBuilder {
  constructor(private readonly t: Transport, private readonly collection: string) {}

  /** Read records. Chain filters, then `await`. */
  select<T = unknown>(): SelectBuilder<T> {
    return new SelectBuilder<T>(this.t, this.collection);
  }

  /** Insert one record; resolves to the stored record. Chain `.requireApproval()` to queue the write instead. */
  insert<T = unknown>(record: Partial<T>): InsertBuilder<T, false> {
    return new InsertBuilder<T, false>(this.t, this.collection, record);
  }

  /** Change one record. Chain `.eq('id', '…')`, then `await`. Add `.requireApproval()` to queue the write. */
  update<T = unknown>(patch: Partial<T>): UpdateBuilder<T, false> {
    return new UpdateBuilder<T, false>(this.t, this.collection, patch);
  }

  /** Delete one record. Chain `.eq('id', '…')`, then `await`. Add `.requireApproval()` to queue the delete. */
  delete<T = unknown>(): DeleteBuilder<T, false> {
    return new DeleteBuilder<T, false>(this.t, this.collection);
  }
}

export function makeFromFactory(t: Transport) {
  return function from(collection: string): FromBuilder {
    return new FromBuilder(t, collection);
  };
}
