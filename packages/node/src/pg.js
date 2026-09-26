// Layer 3 — pg: which SQL queries a request ran, and from which line.
//
// Patches pool.query() and client.query(). Each query is recorded with:
//   sql, the file:line in your code that called it, duration, rows, error
// and added to the current request's context (see context.js).

import { als, callerSite } from './context.js';

const MAX_QUERIES = 50; // per request — keeps the response header small
const MAX_SQL = 2000; // characters

export function instrumentPg(pg) {
  if (pg.Client.prototype.__feelPatched) return;
  pg.Client.prototype.__feelPatched = true;

  // pool.query() hands the SQL to client.query() later, from inside pg's
  // own callbacks — by then your line is gone from the stack. So patch the
  // Pool too, and record there.
  patch(pg.Pool.prototype);
  patch(pg.Client.prototype);
}

function patch(proto) {
  const original = proto.query;

  proto.query = function (config, values, callback) {
    const ctx = als.getStore();
    const sql = typeof config === 'string' ? config : config?.text;
    const site = ctx && sql ? callerSite() : null;

    // No request context, no SQL (e.g. a cursor), or called by pg itself
    // (Pool → Client, already recorded by the Pool patch): pass through.
    if (!site?.file || ctx.queries.length >= MAX_QUERIES) return original.apply(this, arguments);

    const entry = { sql: sql.slice(0, MAX_SQL), ...site, duration: null, rowCount: null, error: null };
    ctx.queries.push(entry);

    const start = performance.now();
    const result = original.apply(this, arguments);
    // Promise style (await pool.query(...)). Callback style isn't timed.
    if (typeof result?.then === 'function') {
      result.then(
        (r) => {
          entry.duration = performance.now() - start;
          entry.rowCount = r?.rowCount ?? null;
        },
        (err) => {
          entry.duration = performance.now() - start;
          entry.error = err.message;
        },
      );
    }
    return result;
  };
}
