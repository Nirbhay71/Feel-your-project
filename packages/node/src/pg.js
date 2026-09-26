// Layer 3 — pg: which SQL queries a request ran, and from which line.
//
// Patches pool.query() and client.query(). Each query is recorded with:
//   sql, the file:line in your code that called it, duration, rows, error
// and added to the current request's context (see context.js).
//
// It also tells Postgres which request is running on each connection, so the
// audit trigger (agent/db.js) can tag every row change with its request:
//   SELECT set_config('feel.request_id', '…', false), set_config('feel.request_label', 'POST /api/orders', false)

import { als, callerSite } from './context.js';

const MAX_QUERIES = 50; // per request — keeps the response header small
const MAX_SQL = 2000; // characters

const TAG_SQL = "SELECT set_config('feel.request_id', $1, false), set_config('feel.request_label', $2, false)";

export function instrumentPg(pg) {
  if (pg.Client.prototype.__feelPatched) return;
  pg.Client.prototype.__feelPatched = true;

  // pool.query() hands the SQL to client.query() later, from inside pg's
  // own callbacks — by then your line is gone from the stack. So patch the
  // Pool too, and record there.
  patch(pg.Pool.prototype, { tagConnection: false });
  patch(pg.Client.prototype, { tagConnection: true });
}

function patch(proto, { tagConnection }) {
  const original = proto.query;

  proto.query = function (config, values, callback) {
    const ctx = als.getStore();

    // Client = one real database connection. Make sure Postgres knows which
    // request (if any) is using it before this query runs.
    if (tagConnection) tag(this, ctx, original);

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

// Pooled connections are reused across requests, so set the request on the
// connection whenever it changes — including clearing it for queries that
// run outside any request, so they aren't blamed on the previous one.
// pg runs a connection's queries strictly in order, so this is guaranteed to
// run before the user's query without waiting for it.
function tag(client, ctx, originalQuery) {
  const id = ctx?.id ?? '';
  if ((client.__feelRequest ?? '') === id) return;
  client.__feelRequest = id;
  const label = ctx ? `${ctx.method} ${ctx.path}` : '';
  originalQuery.call(client, TAG_SQL, [id, label]).catch(() => {});
}
