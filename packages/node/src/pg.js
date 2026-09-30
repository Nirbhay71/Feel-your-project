// Layer 3 — pg: which SQL queries a request ran, and from which line.
//
// Patches pool.query() and client.query() — which also catches every ORM
// that talks to Postgres through pg (Prisma's adapter-pg, Drizzle, Knex,
// Sequelize, TypeORM, …). Each query is recorded with:
//   sql, the file:line in your code that called it, duration, rows, error
// and added to the current request's context (see context.js).
//
// It also tells Postgres which request is running on each connection (before
// the query, waiting for it), so the audit trigger (agent/db.js) can tag every
// row change with its request:
//   SELECT set_config('feel.request_id', '…', false), set_config('feel.request_label', 'POST /api/orders', false)

import { als, callerSite, calledFrom, bindToRequest } from './context.js';

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
  patchConnect(pg.Pool.prototype);
}

// A request waiting for a free client gets it when another request releases
// one — so the callback would run in the releasing request. Bind it to the
// request that asked. pool.query() comes through here too. (Promise style
// needs nothing: code after `await` runs in the awaiting request anyway.)
function patchConnect(proto) {
  const original = proto.connect;
  if (typeof original !== 'function') return;
  proto.connect = function (cb, ...rest) {
    return original.call(this, bindToRequest(cb), ...rest);
  };
}

// Callback style: pg calls it from the connection's socket, in the context
// of whoever opened it. Bind it to the running request (see context.js).
// Streams and cursors ("submittables") report through events instead, and
// are left alone.
function bindCallback(args) {
  if (!als.getStore()) return;
  const [config] = args;
  if (typeof args[1] === 'function') args[1] = bindToRequest(args[1]);
  else if (typeof args[2] === 'function') args[2] = bindToRequest(args[2]);
  else if (typeof config?.callback === 'function' && typeof config.submit !== 'function') {
    args[0] = { ...config, callback: bindToRequest(config.callback) }; // a copy: pg writes into it
  }
}

function patch(proto, { tagConnection }) {
  const original = proto.query;

  proto.query = function (config, values, callback) {
    const ctx = als.getStore();
    const args = arguments;
    const sql = typeof config === 'string' ? config : config?.text;
    bindCallback(args);

    // Record it now, while the caller's line is still on the stack.
    // Skipped without a request context, without SQL (e.g. a cursor), or
    // when pg-pool hands a pool.query() on to a Client (already recorded by
    // the Pool). Queries whose line can't be found — sent by an ORM from
    // deep inside its own code — are still recorded, with file: null.
    let entry = null;
    if (ctx && sql && ctx.queries.length < MAX_QUERIES && !(tagConnection && calledFrom('pg-pool'))) {
      entry = { sql: sql.slice(0, MAX_SQL), ...callerSite(), duration: null, rowCount: null, error: null };
      ctx.queries.push(entry);
    }

    const run = () => {
      const start = performance.now();
      const result = original.apply(this, args);
      // Promise style (await pool.query(...)). Callback style isn't timed.
      if (entry && typeof result?.then === 'function') {
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

    // Client = one real database connection. If Postgres doesn't know yet
    // which request is using it, tell it first — and wait, since pg won't
    // accept a second query while one is running (deprecated, gone in pg 9).
    // Queries sent while a tag is still in flight wait behind it too, so
    // un-awaited sequences (BEGIN; INSERT; …) keep their order.
    const tagging = tagConnection ? (tag(this, ctx, original, config) ?? this.__feelTagging) : null;
    return tagging ? tagging.then(run) : run();
  };
}

// Pooled connections are reused across requests, so set the request on the
// connection whenever it changes — including clearing it for queries that
// run outside any request, so they aren't blamed on the previous one.
// Returns a promise to wait for, or null when nothing needs to change.
//
// Streams/cursors ("submittables") must be handed to pg right away, so they
// can't wait; they keep whatever request the connection had before.
function tag(client, ctx, originalQuery, config) {
  const id = ctx?.id ?? '';
  if ((client.__feelRequest ?? '') === id || typeof config?.submit === 'function') return null;
  client.__feelRequest = id;
  const label = ctx ? `${ctx.method} ${ctx.path}` : '';
  const pending = originalQuery.call(client, TAG_SQL, [id, label]).catch(() => {}); // never block the real query
  client.__feelTagging = pending;
  pending.then(() => {
    if (client.__feelTagging === pending) client.__feelTagging = null;
  });
  return pending;
}
