// Layer 3 — mysql2: which SQL queries a request ran, and from which line.
//
// The MySQL / MariaDB twin of pg.js. Patches query() and execute() on
// mysql2's core Pool and Connection classes — which also catches
// mysql2/promise (its wrappers call the core methods straight away, while
// your line is still on the stack) and Drizzle's drizzle-orm/mysql2. Each
// query is recorded with:
//   sql, the file:line in your code that called it, duration, rows, error
// and added to the current request's context (see context.js).
//
// Unlike pg.js, connections are NOT tagged with the request: that tag only
// feeds the Postgres audit trigger (agent/db.js), and there is no MySQL table
// view yet — so no extra SQL is ever sent.

import { als, callerSite, callerFile } from './context.js';

const MAX_QUERIES = 50; // per request — keeps the response header small
const MAX_SQL = 2000; // characters

// pool.query() / pool.execute() hand the SQL on to a connection from inside
// the getConnection() callback in this file — already recorded by the Pool,
// so the connection must not record it again. The exact file matters, not
// just "somewhere in mysql2": the promise wrappers (lib/promise/*) and
// beginTransaction() (lib/base/connection.js) call the connection directly,
// and those calls are real queries. lib/pool.js is where it lived before
// mysql2 split out lib/base/. Path-based, so a server bundle that inlines
// mysql2 (webpack, Next) can't be told apart and may record pool calls twice.
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
}

// The object in the prototype chain that owns `name`: lib/base/pool.js and
// lib/base/connection.js in mysql2 3.9+, Pool and Connection before that.
// PoolConnection extends Connection without overriding query, so it's
// covered too. (Deep-requiring mysql2/lib/… is blocked by its "exports".)
function owner(proto, name) {
  while (proto && !Object.hasOwn(proto, name)) proto = Object.getPrototypeOf(proto);
  return proto ?? null;
}

function patch(proto, name, { pool }) {
  const original = proto[name];
  if (typeof original !== 'function') return;

  proto[name] = function (...args) {
    const ctx = als.getStore();
    // Read it now: Connection.query overwrites cmd.sql with the formatted SQL.
    const sql = sqlOf(args[0]);

    // Record it now, while the caller's line is still on the stack. Cheapest
    // checks first — the stack is only read for connection calls inside a
    // request. Queries whose line can't be found (sent by an ORM from deep
    // inside its own code) are still recorded, with file: null.
    const record = ctx && sql && ctx.queries.length < MAX_QUERIES && (pool || !FROM_POOL.test(callerFile() ?? ''));
    if (!record) return original.apply(this, args);

    const entry = { sql: sql.slice(0, MAX_SQL), ...callerSite(), duration: null, rowCount: null, error: null };
    ctx.queries.push(entry);
    const start = performance.now();
    const done = () => (entry.duration ??= performance.now() - start);

    // Time it through the callback (the promise API passes one too). Never
    // add a callback where there was none: without one, mysql2 reports
    // errors differently (events, or throwing for pool.execute).
    const i = typeof args[1] === 'function' ? 1 : typeof args[2] === 'function' ? 2 : -1;
    if (i >= 0) args[i] = wrapCallback(args[i], entry, done);

    let result;
    try {
      result = original.apply(this, args);
    } catch (err) {
      // e.g. execute() with an undefined bind parameter throws right away
      done();
      entry.error = err?.message ?? String(err);
      throw err;
    }

    // No callback: the result is a Command (an EventEmitter) — .stream(),
    // on('result'), Drizzle's iterator. Watch it without changing it: an
    // 'error' listener would swallow errors the app expects to crash on, so
    // errors are read by wrapping emit on this one command instead. Rows
    // aren't counted here (they may be streamed). Don't test for .then —
    // mysql2's Query has one that throws on purpose.
    if (i < 0 && typeof result?.once === 'function') {
      result.once('end', done);
      const emit = result.emit;
      result.emit = function (event, err, ...rest) {
        if (event === 'error') entry.error ??= err?.message ?? String(err);
        return emit.call(this, event, err, ...rest);
      };
    }
    return result;
  };
}

// query('SQL', …) / query({ sql, … }, …) / the Query object Pool hands on.
function sqlOf(arg) {
  if (typeof arg === 'string') return arg;
  return typeof arg?.sql === 'string' ? arg.sql : null;
}

function wrapCallback(cb, entry, done) {
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
