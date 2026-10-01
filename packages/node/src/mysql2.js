// Layer 3 — mysql2: which SQL queries a request ran, and from which line.
//
// The MySQL / MariaDB twin of pg.js. Patches query() and execute() on
// mysql2's core Pool and Connection classes — which also catches
// mysql2/promise (its wrappers call the core methods straight away, while
// your line is still on the stack) and Drizzle's drizzle-orm/mysql2. Each
// query is recorded with:
//   sql, the file:line in your code that called it, duration, rows, error
// and added to the current request's context (see context.js). Callbacks
// and events run in the request that sent the query, so queries sent from
// inside a callback are that request's too — not the one that happened to
// open the pooled connection.
//
// Unlike pg.js, connections are NOT tagged with the request: that tag only
// feeds the Postgres audit trigger (agent/db.js), and there is no MySQL table
// view yet — so no extra SQL is ever sent.

import { AsyncResource } from 'node:async_hooks';
import { als, callerSite, callerFile, bindToRequest } from './context.js';

const MAX_QUERIES = 50; // per request — keeps the response header small
const MAX_SQL = 2000; // characters

// pool.query() / pool.execute() hand the SQL on to a connection from inside
// the getConnection() callback — already recorded by the Pool, so the
// connection must not record it again.
//
// pool.query() passes the Query object it returned to the caller, so those
// are remembered here and recognised by identity.
const handedOn = new WeakSet();

// pool.execute() passes plain arguments, so it's recognised by the file that
// makes the call instead. The exact file matters, not just "somewhere in
// mysql2": the promise wrappers (lib/promise/*) and beginTransaction()
// (lib/base/connection.js) call the connection directly, and those calls are
// real queries. lib/pool.js is where it lived before mysql2 split out
// lib/base/. Path-based, so a server bundle that inlines mysql2 (webpack,
// Next) can't be told apart and may record pool.execute() calls twice.
export const FROM_POOL = /[\\/]mysql2[\\/]lib[\\/](base[\\/])?pool\.js$/;

export function instrumentMysql2(mysql2) {
  const poolProto = owner(mysql2.Pool?.prototype, 'query');
  const connProto = owner(mysql2.Connection?.prototype, 'query');
  if (!poolProto || !connProto || connProto.__feelPatched) return;
  connProto.__feelPatched = true;

  // The Pool records on the caller's stack, before the query waits in the
  // pool's queue for a free connection (where the request context and your
  // line could get lost).
  for (const name of ['query', 'execute']) {
    patch(poolProto, name, { pool: true });
    patch(connProto, name, { pool: false });
  }
  patchPrepare(owner(mysql2.Connection?.prototype, 'prepare'));
  patchGetConnection(owner(mysql2.Pool?.prototype, 'getConnection'));
}

// The object in the prototype chain that owns `name`: lib/base/pool.js and
// lib/base/connection.js in mysql2 3.9+, Pool and Connection before that.
// PoolConnection extends Connection without overriding query, so it's
// covered too. (Deep-requiring mysql2/lib/… is blocked by its "exports".)
function owner(proto, name) {
  while (proto && !Object.hasOwn(proto, name)) proto = Object.getPrototypeOf(proto);
  return proto ?? null;
}

// A request waiting for a free connection gets it when another request
// releases one — so the callback would run in the releasing request. Bind it
// to the request that asked. pool.query(), pool.execute() and
// mysql2/promise's getConnection() all come through here.
function patchGetConnection(proto) {
  const original = proto?.getConnection;
  if (typeof original !== 'function') return;
  proto.getConnection = function (cb, ...rest) {
    return original.call(this, bindToRequest(cb), ...rest);
  };
}

function patchPrepare(proto) {
  const original = proto?.prepare;
  if (typeof original !== 'function') return;

  proto.prepare = function (options, callback) {
    if (typeof callback !== 'function') return original.apply(this, arguments);
    return original.call(
      this,
      options,
      bindToRequest(function (err, statement) {
        if (!err && statement) patchPreparedStatement(statement);
        return callback.apply(this, arguments);
      }),
    );
  };
}

function patchPreparedStatement(statement) {
  const original = statement.execute;
  if (typeof original !== 'function') return;

  statement.execute = function (...args) {
    const ctx = als.getStore();
    return ctx ? run(this, original, args, ctx, false, statement.query) : original.apply(this, args);
  };
}

function patch(proto, name, { pool }) {
  const original = proto[name];
  if (typeof original !== 'function') return;

  proto[name] = function (...args) {
    const ctx = als.getStore();
    if (!pool && handedOn.has(args[0])) return original.apply(this, args);
    const result = ctx ? run(this, original, args, ctx, pool) : original.apply(this, args);
    if (pool && name === 'query' && typeof result === 'object' && result) handedOn.add(result);
    return result;
  };
}

// Inside a request: record the query (unless it's a repeat or over the cap)
// and bind its callback or events to the request — always, recorded or not,
// since queries sent from that callback depend on it.
function run(self, original, args, ctx, pool, preparedSql) {
  // Read it now: Connection.query overwrites cmd.sql with the formatted SQL.
  const sql = preparedSql ?? sqlOf(args[0]);

  // Record it now, while the caller's line is still on the stack. Cheapest
  // checks first — the stack is only read for connection calls. Queries
  // whose line can't be found (sent by an ORM from deep inside its own code)
  // are still recorded, with file: null.
  const record = sql && ctx.queries.length < MAX_QUERIES && (pool || !FROM_POOL.test(callerFile() ?? ''));
  const entry = record ? { sql: sql.slice(0, MAX_SQL), ...callerSite(), duration: null, rowCount: null, error: null } : null;
  if (entry) ctx.queries.push(entry);
  const start = performance.now();
  const done = () => entry && (entry.duration ??= performance.now() - start);

  // Time it through the callback (the promise API passes one too). Never
  // add a callback where there was none: without one, mysql2 reports
  // errors differently (events, or throwing for pool.execute).
  const i = typeof args[1] === 'function' ? 1 : typeof args[2] === 'function' ? 2 : -1;
  if (i >= 0) args[i] = wrapCallback(bindToRequest(args[i]), entry, done);

  let result;
  try {
    result = original.apply(self, args);
  } catch (err) {
    // e.g. execute() with an undefined bind parameter throws right away
    done();
    if (entry) entry.error = err?.message ?? String(err);
    throw err;
  }

  // No callback: the result is a Command (an EventEmitter) — .stream(),
  // on('result'), Drizzle's iterator. Watch it without changing it: an
  // 'error' listener would swallow errors the app expects to crash on, so
  // errors are read by wrapping emit on this one command instead — which
  // also runs its listeners in this request. mysql2 may emit 'error' without
  // 'end' (a closed pool, a refused connection), so both end the timing.
  // Rows aren't counted here (they may be streamed). Don't test for .then —
  // mysql2's Query has one that throws on purpose.
  if (i < 0 && typeof result?.once === 'function') {
    result.once('end', done);
    const emit = result.emit;
    const resource = new AsyncResource('feel.mysql2');
    result.emit = function (event, err, ...rest) {
      if (event === 'error') {
        done();
        if (entry) entry.error ??= err?.message ?? String(err);
      }
      return resource.runInAsyncScope(emit, this, event, err, ...rest);
    };
  }
  return result;
}

// query('SQL', …) / query({ sql, … }, …) / the Query object Pool hands on.
function sqlOf(arg) {
  if (typeof arg === 'string') return arg;
  return typeof arg?.sql === 'string' ? arg.sql : null;
}

function wrapCallback(cb, entry, done) {
  if (!entry) return cb;
  return function (err, rows, fields) {
    done();
    if (err) entry.error = err.message ?? String(err);
    else entry.rowCount = rowCountOf(rows, fields);
    return cb.apply(this, arguments);
  };
}

// SELECT → rows returned; INSERT/UPDATE/DELETE → rows affected. A
// multi-statement query ("SELECT …; UPDATE …") gives one result per
// statement — [rows, header, rows] with fields [cols, undefined, cols] — so
// add them up. (With rowsAsArray, fields[0] is a column, not an array.)
export function rowCountOf(rows, fields) {
  const multi = Array.isArray(rows) && Array.isArray(fields) && fields.length > 0 && fields.every((f) => f === undefined || Array.isArray(f));
  if (!multi) return countOf(rows);
  return rows.reduce((sum, r) => sum + (countOf(r) ?? 0), 0);
}

function countOf(result) {
  if (Array.isArray(result)) return result.length;
  return typeof result?.affectedRows === 'number' ? result.affectedRows : null;
}
