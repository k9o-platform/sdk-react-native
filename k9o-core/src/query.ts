/**
 * `core.query(sql, params?)`: one parameterised, read-only SQL statement. POST /@<slug>/query { sql, params? }.
 *
 * `params` is a list (positional, `$1, $2, …`, SQL sent as written) or an object of named values (`:name`
 * placeholders are rewritten to `$n` here). Values are bound by the database, never interpolated.
 */

import type { Envelope } from "./CoreClient";
import { invalidField, projectPath, type Transport } from "./transport";

/** A bindable value. Serialise anything richer (objects, arrays, dates) to text first. */
export type QueryValue = string | number | boolean | null;
export type QueryParams = ReadonlyArray<QueryValue> | Readonly<Record<string, QueryValue>>;

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

const invalid = (message: string, context: Record<string, unknown> = {}) => invalidField(message, context);

function checkValue(value: unknown, where: string): QueryValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw invalid(
    `${where} must be a string, number, boolean or null; serialise anything else (for example as JSON text) first`,
  );
}

/**
 * Rewrite `:name` placeholders to `$n`. Skips quoted text, comments, dollar-quoted strings and `::` casts, so
 * `data->>'role' = :role` and `x::int` come out right. Exported for tests.
 */
export function translateNamedParams(
  sql: string,
  named: Readonly<Record<string, unknown>>,
): { sql: string; params: QueryValue[] } {
  const order: string[] = [];
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "'" || ((c === "E" || c === "e") && next === "'" && !(i > 0 && IDENT_CHAR.test(sql[i - 1]!)))) {
      const escapes = c !== "'";
      let j = escapes ? i + 2 : i + 1;
      for (; j < n; j++) {
        if (escapes && sql[j] === "\\") { j++; continue; }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j++; continue; }
          break;
        }
      }
      out += sql.slice(i, Math.min(j + 1, n));
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < n; j++) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j++; continue; }
          break;
        }
      }
      out += sql.slice(i, Math.min(j + 1, n));
      i = j + 1;
    } else if (c === "-" && next === "-") {
      let j = sql.indexOf("\n", i);
      if (j === -1) j = n;
      out += sql.slice(i, j);
      i = j;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") { depth++; j += 2; }
        else if (sql[j] === "*" && sql[j + 1] === "/") { depth--; j += 2; }
        else j++;
      }
      out += sql.slice(i, j);
      i = j;
    } else if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m !== null) {
        const close = sql.indexOf(m[0], i + m[0].length);
        const end = close === -1 ? n : close + m[0].length;
        out += sql.slice(i, end);
        i = end;
      } else {
        out += c;
        i++;
      }
    } else if (c === ":" && next === ":") {
      out += "::";
      i += 2;
    } else if (c === ":" && next !== undefined && IDENT_START.test(next) && !(i > 0 && IDENT_CHAR.test(sql[i - 1]!))) {
      let j = i + 2;
      while (j < n && IDENT_CHAR.test(sql[j]!)) j++;
      const name = sql.slice(i + 1, j);
      let idx = order.indexOf(name);
      if (idx === -1) {
        if (!Object.prototype.hasOwnProperty.call(named, name)) throw invalid(`no value for :${name}`, { name });
        order.push(name);
        idx = order.length - 1;
      }
      out += `$${idx + 1}`;
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return { sql: out, params: order.map((name) => checkValue(named[name], `the value for :${name}`)) };
}

export function makeQuery(t: Transport) {
  return async function query<T = Record<string, unknown>>(
    sql: string,
    params?: QueryParams,
  ): Promise<Envelope<ReadonlyArray<T>>> {
    const path = projectPath(t, "query", "query");
    let text = sql;
    let values: QueryValue[] = [];
    if (Array.isArray(params)) {
      values = params.map((v, i) => checkValue(v, `params[${i}]`));
    } else if (params !== undefined && params !== null) {
      ({ sql: text, params: values } = translateNamedParams(sql, params as Record<string, unknown>));
    }
    const body: { sql: string; params?: QueryValue[] } = { sql: text };
    if (values.length > 0) body.params = values;
    return t.request<ReadonlyArray<T>>("POST", path, { body });
  };
}
