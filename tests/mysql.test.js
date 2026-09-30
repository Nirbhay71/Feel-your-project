// mysql2 through @feel-dev/node, without a database: mysql2's own
// createServer() plays a tiny MySQL server on a free local port, so the real
// client — Pool, Connection, mysql2/promise, Drizzle — runs its normal paths
// (the "record once" rule depends on real mysql2 stacks). Each query must
// land in X-Feel-Route once, with the line of *your* code that asked for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import mysql from 'mysql2';
import mysqlp from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { mysqlTable, int, varchar } from 'drizzle-orm/mysql-core';
import { eq } from 'drizzle-orm';
import * as mysqlCore from 'drizzle-orm/mysql-core';
import * as mysqlRelational from 'drizzle-orm/mysql-core/query-builders/query';
import { instrumentExpress, instrumentMysql2, instrumentDrizzle } from '../packages/node/src/index.js';
import { FROM_POOL, rowCountOf } from '../packages/node/src/mysql2.js';
import { createAgent } from '../packages/agent/src/index.js';

instrumentExpress(express);
instrumentMysql2(mysql);
instrumentDrizzle({ dialects: [mysqlCore], relational: [mysqlRelational] });

// --- A MySQL server that answers from a script ----------------------------------
//   SQL with "nope"        → error 1146 (no such table)
//   SELECT … (upper case)  → 2 rows
//   select … (Drizzle)     → no rows
//   anything else          → OK, 3 rows affected
//   prepared (execute)     → OK, 1 row affected
// Every statement it receives goes into serverLog, so tests can check that
// nothing extra is ever sent.

const serverLog = [];

// mysql2 doesn't export its packet writer; an absolute path gets past its
// package "exports" (only needed to answer COM_STMT_PREPARE).
const require = createRequire(import.meta.url);
const Packet = require(path.join(path.dirname(require.resolve('mysql2')), 'lib', 'packets', 'packet.js'));

const ID_COLUMN = { name: 'id', columnType: 3, columnLength: 11, characterSet: 63, flags: 0, decimals: 0, catalog: 'def', schema: 'feel', table: 't', orgTable: 't', orgName: 'id' };

const server = mysql.createServer();
let statementId = 1;
server.on('connection', (conn) => {
  // The fake auth answer is sent as packet 2; every exchange after that
  // starts again at 0 — otherwise the client warns "packets out of order".
  conn.serverHandshake({
    protocolVersion: 10,
    serverVersion: '8.0.0-fake',
    connectionId: 1,
    statusFlags: 2,
    characterSet: 8,
    capabilityFlags: 0xffffff,
    authCallback: (_, done) => {
      conn.sequenceId = 2;
      done(null);
      conn.sequenceId = 0;
    },
  });
  conn.on('error', () => {}); // the client hanging up is fine
  const reply = (fn) => (...args) => {
    fn(...args);
    conn.sequenceId = 0;
  };
  conn.on(
    'query',
    reply((sql) => {
      serverLog.push(sql);
      if (/nope/.test(sql)) return conn.writeError({ code: 1146, message: "Table 'feel.nope' doesn't exist" });
      if (/^\s*SELECT/.test(sql)) return conn.writeTextResult([{ id: 1 }, { id: 2 }], [ID_COLUMN]);
      if (/^\s*select/.test(sql)) return conn.writeTextResult([], [ID_COLUMN]);
      conn.writeOk({ affectedRows: 3 });
    }),
  );
  conn.on(
    'stmt_prepare',
    reply((sql) => {
      serverLog.push(sql);
      // COM_STMT_PREPARE_OK: 0x00, statement id, 0 columns, 0 params, 0x00, 0 warnings
      const buf = Buffer.alloc(4 + 12);
      const p = new Packet(0, buf, 0, buf.length);
      p.offset = 4;
      p.writeInt8(0);
      p.writeInt32(statementId++);
      p.writeInt16(0);
      p.writeInt16(0);
      p.writeInt8(0);
      p.writeInt16(0);
      conn.writePacket(p);
    }),
  );
  conn.on(
    'stmt_execute',
    reply(() => conn.writeOk({ affectedRows: 1 })),
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

// mysql2's Server wraps a net.Server as the private _server and has no
// address() of its own.
const serverPort = () => server._server.address().port;
const config = { host: '127.0.0.1', port: serverPort(), user: 'feel', password: 'feel', database: 'feel' };

// --- The app --------------------------------------------------------------------

const pool = mysqlp.createPool(config);
const cbPool = mysql.createPool(config);
const connections = []; // single connections, closed at the end
const users = mysqlTable('users', { id: int('id').primaryKey().autoincrement(), name: varchar('name', { length: 255 }) });
const db = drizzle(pool, { schema: { users }, mode: 'default' });

// One connection, opened before any request: mysql2 answers every callback
// from that socket — i.e. from outside every request, like a real app's pool.
const onePool = mysql.createPool({ ...config, connectionLimit: 1 });
await new Promise((resolve) => onePool.query('SELECT 0', resolve));

const app = express();
app.get('/promise', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM `users`'); // PROMISE_QUERY
  res.json(rows);
});
app.get('/execute', async (req, res) => {
  await pool.execute('SELECT * FROM users WHERE id = ?', [1]); // POOL_EXECUTE
  res.end();
});
app.get('/update', async (req, res) => {
  const [r] = await pool.query('UPDATE users SET a = 1'); // POOL_UPDATE
  res.json(r);
});
app.get('/callback-pool', (req, res) => {
  cbPool.query('SELECT 1', (err, rows) => res.json({ err, rows })); // CALLBACK_POOL
});
app.get('/callback-connection', (req, res) => {
  const conn = mysql.createConnection(config);
  connections.push(conn);
  conn.query('SELECT 2', (err, rows) => res.json({ err, rows })); // CALLBACK_CONNECTION
});
app.get('/get-connection', async (req, res) => {
  const conn = await pool.getConnection();
  await conn.beginTransaction(); // BEGIN_TRANSACTION
  await conn.query('SELECT 1'); // CONN_QUERY
  await conn.commit(); // COMMIT
  conn.release();
  res.end();
});
app.get('/error', async (req, res) => {
  try {
    await pool.query('SELECT * FROM nope'); // FAILING_QUERY
    res.end();
  } catch (err) {
    res.json({ message: err.message });
  }
});
app.get('/closed', async (req, res) => {
  const closed = mysqlp.createPool(config);
  await closed.end();
  try {
    await closed.query('SELECT 1'); // CLOSED_POOL
  } catch (err) {
    res.json({ message: err.message });
  }
});
app.get('/nested', (req, res) => {
  const { id } = req.query;
  onePool.query(`SELECT '${id}-outer'`, () => {
    onePool.execute(`SELECT '${id}-inner'`, [], () => res.end());
  });
});
app.get('/nested-connection', (req, res) => {
  const { id } = req.query;
  onePool.getConnection((err, conn) => {
    conn.query(`SELECT '${id}-held'`, () => {
      conn.query(`SELECT '${id}-again'`, () => {
        conn.release();
        res.end();
      });
    });
  });
});
app.get('/nested-events', (req, res) => {
  const { id } = req.query;
  onePool.query(`SELECT '${id}-outer'`).on('end', () => {
    onePool.query(`SELECT '${id}-inner'`, () => res.end());
  });
});
app.get('/over-cap', (req, res) => {
  const { id } = req.query;
  let left = 50;
  const next = () => (left-- ? onePool.query('SELECT 1', next) : onePool.query(`SELECT '${id}-51'`, () => res.end()));
  next();
});
app.get('/emitter-error', (req, res) => {
  cbPool.query('SELECT * FROM nope').on('error', () => {}).on('end', () => res.end());
});
app.get('/emitter-closed', async (req, res) => {
  const closed = mysql.createPool(config);
  await new Promise((resolve) => closed.end(resolve));
  // mysql2 emits 'error' and no 'end' here; the response goes out right away.
  closed.query('SELECT 1').on('error', (err) => res.json({ message: err.message }));
});
app.get('/stream', (req, res) => {
  const conn = mysql.createConnection(config);
  connections.push(conn);
  conn.query('SELECT 5').stream().on('data', () => {}).on('end', () => res.end());
});
app.get('/undefined-param-connection', (req, res) => {
  const conn = mysql.createConnection(config);
  connections.push(conn);
  try {
    conn.execute('SELECT ?', [undefined], () => {}); // UNDEFINED_PARAM
    res.end();
  } catch (err) {
    res.json({ message: err.message });
  }
});
app.get('/drizzle', async (req, res) => {
  const rows = await db.select().from(users).where(eq(users.id, 1)); // DRIZZLE_SELECT
  res.json(rows);
});
app.get('/drizzle-parallel', async (req, res) => {
  await Promise.all([
    db.insert(users).values({ name: 'Ada' }), // DRIZZLE_INSERT
    db.delete(users).where(eq(users.id, 2)), // DRIZZLE_DELETE
  ]);
  res.end();
});
app.get('/drizzle-relational', async (req, res) => {
  res.json(await db.query.users.findMany()); // DRIZZLE_RELATIONAL
});
app.get('/drizzle-transaction', async (req, res) => {
  await db.transaction(async (tx) => {
    await tx.update(users).set({ name: 'Grace' }).where(eq(users.id, 1)); // DRIZZLE_TX_UPDATE
  });
  res.end();
});

const THIS_FILE = fileURLToPath(import.meta.url);
const SOURCE = fs.readFileSync(THIS_FILE, 'utf8').split('\n');
const lineOf = (marker) => SOURCE.findIndex((l) => l.includes(`// ${marker}`)) + 1;

async function request(url) {
  const listening = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${listening.address().port}${url}`);
    const body = await res.text();
    const route = JSON.parse(decodeURIComponent(res.headers.get('x-feel-route')));
    return { queries: route.queries, truncated: route.truncated ?? 0, body: body ? JSON.parse(body) : null };
  } finally {
    await new Promise((resolve) => listening.close(resolve));
  }
}
const queriesOf = async (url) => (await request(url)).queries;

// --- Raw mysql2 -----------------------------------------------------------------

test('mysql2/promise pool.query: one entry with line, timing and rows', async () => {
  const queries = await queriesOf('/promise');
  assert.equal(queries.length, 1);
  const [q] = queries;
  assert.equal(q.sql, 'SELECT * FROM `users`');
  assert.equal(q.file, THIS_FILE);
  assert.equal(q.line, lineOf('PROMISE_QUERY'));
  assert.equal(typeof q.column, 'number');
  assert.equal(typeof q.duration, 'number');
  assert.equal(q.rowCount, 2);
  assert.equal(q.error, null);
});

test('pool.execute: recorded once, not again when the pool hands it to a connection', async () => {
  const queries = await queriesOf('/execute');
  assert.deepEqual(
    queries.map((q) => [q.sql, q.line]),
    [['SELECT * FROM users WHERE id = ?', lineOf('POOL_EXECUTE')]],
  );
  assert.equal(typeof queries[0].duration, 'number');
});

test('UPDATE: rowCount is the number of rows affected', async () => {
  const [q, ...rest] = await queriesOf('/update');
  assert.equal(rest.length, 0);
  assert.equal(q.rowCount, 3);
  assert.equal(q.line, lineOf('POOL_UPDATE'));
});

test('callback style, on a pool and on a single connection', async () => {
  for (const [url, marker] of [
    ['/callback-pool', 'CALLBACK_POOL'],
    ['/callback-connection', 'CALLBACK_CONNECTION'],
  ]) {
    const queries = await queriesOf(url);
    assert.equal(queries.length, 1, url);
    assert.equal(queries[0].line, lineOf(marker), url);
    assert.equal(typeof queries[0].duration, 'number', url);
    assert.equal(queries[0].rowCount, 2, url);
  }
});

test('getConnection + transaction: each statement once, on its own line', async () => {
  const queries = await queriesOf('/get-connection');
  assert.deepEqual(
    queries.map((q) => [q.sql, q.line]),
    [
      ['START TRANSACTION', lineOf('BEGIN_TRANSACTION')],
      ['SELECT 1', lineOf('CONN_QUERY')],
      ['COMMIT', lineOf('COMMIT')],
    ],
  );
});

test('a failing query records the MySQL error; the app still sees it', async () => {
  const { queries, body } = await request('/error');
  assert.equal(queries.length, 1);
  assert.equal(queries[0].error, "Table 'feel.nope' doesn't exist");
  assert.equal(queries[0].line, lineOf('FAILING_QUERY'));
  assert.equal(body.message, "Table 'feel.nope' doesn't exist");
});

test('a query on a closed pool is recorded with its error, without crashing', async () => {
  const { queries, body } = await request('/closed');
  assert.equal(body.message, 'Pool is closed.');
  assert.deepEqual(
    queries.map((q) => [q.sql, q.line, q.error]),
    [['SELECT 1', lineOf('CLOSED_POOL'), 'Pool is closed.']],
  );
});

test('no extra SQL is ever sent — outside a request or inside one', async () => {
  const before = serverLog.length;
  const [rows] = await pool.query('SELECT 42');
  assert.equal(rows.length, 2);
  assert.deepEqual(serverLog.slice(before), ['SELECT 42']);

  const during = serverLog.length;
  await queriesOf('/update');
  assert.deepEqual(serverLog.slice(during), ['UPDATE users SET a = 1']);
});

// --- Callbacks run in their own request ------------------------------------------
// mysql2 calls callbacks from the socket's event handler, which runs in the
// context of whoever opened the socket — here, nobody (onePool is warmed up
// before any request). Queries sent from a callback must still land in the
// request that sent the first one, never in another request.

async function eachOwnsItsQueries(url, suffixes) {
  const ids = ['r0', 'r1', 'r2', 'r3'];
  const results = await Promise.all(ids.map((id) => queriesOf(`${url}?id=${id}`)));
  results.forEach((queries, n) => {
    assert.deepEqual(
      queries.map((q) => q.sql).filter((sql) => sql.includes("'r")),
      suffixes.map((s) => `SELECT '${ids[n]}-${s}'`),
      `${url} ${ids[n]}`,
    );
  });
}

test('callback style: a query sent from a callback stays in its request', async () => {
  const queries = await queriesOf('/nested?id=r9');
  assert.deepEqual(
    queries.map((q) => q.sql),
    ["SELECT 'r9-outer'", "SELECT 'r9-inner'"],
  );
  assert.ok(queries.every((q) => typeof q.duration === 'number'));
});

test('callback style on a one-connection pool: parallel requests each get only their own queries', async () => {
  await eachOwnsItsQueries('/nested', ['outer', 'inner']);
});

test('getConnection(callback) waiting in the pool queue runs in the request that asked', async () => {
  await eachOwnsItsQueries('/nested-connection', ['held', 'again']);
});

test('event style: listeners run in the request that sent the query', async () => {
  await eachOwnsItsQueries('/nested-events', ['outer', 'inner']);
});

test('callbacks stay in their request even when queries are over the cap', async () => {
  const [a, b] = await Promise.all([request('/over-cap?id=ra'), request('/over-cap?id=rb')]);
  // 50 recorded each; the header size cap may leave the last few out (how many
  // depends on how long this file's path is), but they're counted as truncated.
  for (const r of [a, b]) {
    assert.equal(r.queries.length + r.truncated, 50);
    assert.ok(r.queries.every((q) => q.sql === 'SELECT 1'));
  }
});

// --- No callback: events, streams, throws -----------------------------------------

test('event style: an error is recorded with its duration, no listener added', async () => {
  const queries = await queriesOf('/emitter-error');
  assert.equal(queries.length, 1);
  assert.equal(queries[0].error, "Table 'feel.nope' doesn't exist");
  assert.equal(typeof queries[0].duration, 'number');
});

test("event style: 'error' without 'end' (closed pool) still gets a duration", async () => {
  const { queries, body } = await request('/emitter-closed');
  assert.equal(body.message, 'Pool is closed.');
  assert.equal(queries.length, 1);
  assert.equal(queries[0].error, 'Pool is closed.');
  assert.equal(typeof queries[0].duration, 'number');
});

test('.stream(): recorded once, with a duration', async () => {
  const queries = await queriesOf('/stream');
  assert.deepEqual(
    queries.map((q) => q.sql),
    ['SELECT 5'],
  );
  assert.equal(typeof queries[0].duration, 'number');
});

test('execute() with an undefined parameter: the error is recorded, the app still gets it', async () => {
  const { queries, body } = await request('/undefined-param-connection');
  assert.match(body.message, /Bind parameters must not contain undefined/);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].line, lineOf('UNDEFINED_PARAM'));
  assert.match(queries[0].error, /Bind parameters must not contain undefined/);
  assert.equal(typeof queries[0].duration, 'number');
});

// --- Drizzle (drizzle-orm/mysql2) -----------------------------------------------

test('drizzle: a lazy query gets the line that built it', async () => {
  const [q, ...rest] = await queriesOf('/drizzle');
  assert.equal(rest.length, 0);
  assert.match(q.sql, /^select .* from `users` where `users`\.`id` = \?$/);
  assert.equal(q.file, THIS_FILE);
  assert.equal(q.line, lineOf('DRIZZLE_SELECT'));
  assert.equal(q.rowCount, 0);
});

test('drizzle: queries awaited together each keep their own line', async () => {
  const queries = await queriesOf('/drizzle-parallel');
  const lineFor = (verb) => queries.find((q) => q.sql.startsWith(verb))?.line;
  assert.equal(queries.length, 2);
  assert.equal(lineFor('insert'), lineOf('DRIZZLE_INSERT'));
  assert.equal(lineFor('delete'), lineOf('DRIZZLE_DELETE'));
});

test('drizzle: db.query.<table>.findMany()', async () => {
  const queries = await queriesOf('/drizzle-relational');
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /from `users`/);
  assert.equal(queries[0].line, lineOf('DRIZZLE_RELATIONAL'));
});

test('drizzle: a transaction records begin / update / commit once each', async () => {
  const queries = await queriesOf('/drizzle-transaction');
  assert.deepEqual(
    queries.map((q) => q.sql.split(' ')[0]),
    ['begin', 'update', 'commit'],
  );
  assert.equal(queries[1].line, lineOf('DRIZZLE_TX_UPDATE'));
});

// --- Pieces -----------------------------------------------------------------------

test('the pool hand-off is recognised on Windows and POSIX paths', () => {
  assert.ok(FROM_POOL.test('C:\\app\\node_modules\\mysql2\\lib\\base\\pool.js'));
  assert.ok(FROM_POOL.test('/app/node_modules/mysql2/lib/base/pool.js'));
  assert.ok(FROM_POOL.test('/app/node_modules/mysql2/lib/pool.js')); // before lib/base/
  assert.ok(!FROM_POOL.test('C:\\app\\node_modules\\mysql2\\lib\\promise\\pool.js'));
  assert.ok(!FROM_POOL.test('/app/node_modules/mysql2/lib/base/connection.js'));
  assert.ok(!FROM_POOL.test('/app/node_modules/mysql2/lib/pool_cluster.js'));
  assert.ok(!FROM_POOL.test('/app/src/pool.js'));
});

test('pool.query is recorded once even when mysql2 is bundled under another path', async () => {
  // A server bundle (webpack, Next) moves mysql2's files, so the pool can't
  // be recognised by its path; pool.query must still not be recorded twice.
  // The copy sits in node_modules so it finds mysql2's own dependencies.
  const dir = path.join(path.dirname(THIS_FILE), '..', 'node_modules', '.cache', `feel-bundle-${process.pid}`);
  fs.cpSync(path.dirname(require.resolve('mysql2')), dir, { recursive: true });
  try {
    const bundled = require(dir);
    instrumentMysql2(bundled);
    const bundledPool = bundled.createPool(config);
    const app2 = express();
    app2.get('/', (req, res) => {
      bundledPool.query('SELECT 7', () => res.end());
    });
    const listening = app2.listen(0);
    const res = await fetch(`http://127.0.0.1:${listening.address().port}/`);
    await new Promise((resolve) => listening.close(resolve));
    await new Promise((resolve) => bundledPool.end(resolve));
    const queries = JSON.parse(decodeURIComponent(res.headers.get('x-feel-route'))).queries;
    assert.deepEqual(
      queries.map((q) => q.sql),
      ['SELECT 7'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rowCount: rows, affected rows, and multi-statement results', () => {
  const cols = [{ name: 'id' }];
  assert.equal(rowCountOf([{ id: 1 }, { id: 2 }], cols), 2);
  assert.equal(rowCountOf({ affectedRows: 4 }, undefined), 4);
  assert.equal(rowCountOf([[1], [2], [3]], cols), 3); // rowsAsArray
  assert.equal(rowCountOf([[{ id: 1 }], { affectedRows: 2 }, [{ id: 1 }, { id: 2 }]], [cols, undefined, cols]), 5);
});

test('agent: a MySQL database URL gives a clear table-view error, no pg connection', async () => {
  const agent = createAgent({ root: path.dirname(THIS_FILE), database: 'mysql://u:p@127.0.0.1:1/x' });
  const call = (url) =>
    new Promise((resolve) => {
      const res = {
        statusCode: 0,
        headers: {},
        setHeader(k, v) {
          this.headers[k] = v;
        },
        end(body) {
          resolve({ status: this.statusCode, body: JSON.parse(body) });
        },
      };
      agent({ method: 'GET', url, headers: { host: 'localhost' } }, res, () => resolve(null));
    });

  const table = await call('/db/table?name=users');
  assert.equal(table.status, 501);
  assert.match(table.body.error, /Postgres-only/);
  assert.deepEqual(await call('/db/changes?request=abc'), { status: 200, body: { audit: false, changes: [] } });
});

// Close every client first — server.close() waits for open sockets.
test.after(async () => {
  await pool.end();
  await new Promise((resolve) => cbPool.end(resolve));
  await new Promise((resolve) => onePool.end(resolve));
  await Promise.all(connections.map((c) => new Promise((resolve) => c.end(resolve))));
  await new Promise((resolve) => server.close(resolve));
});
