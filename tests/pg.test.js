// pg callback style through @feel-dev/node, without a database. pg calls
// callbacks from its socket's event handler, which runs in the context of
// whoever opened the socket — often an earlier request, or none. The fake
// Client below does the same: every answer comes from a "socket" created at
// startup, outside any request. Queries sent from a callback must still land
// in the request that sent the first one, never in another request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import express from 'express';
import pg from 'pg';
import { instrumentExpress, instrumentPg } from '../packages/node/src/index.js';

// --- A Postgres whose answers all come from one startup-time socket ----------------

const socket = new AsyncResource('fake-pg-socket');
const fromSocket = (fn) => setImmediate(() => socket.runInAsyncScope(fn));

pg.Client.prototype.connect = function (callback) {
  fromSocket(() => callback(null, this));
};
pg.Client.prototype.query = function (config, values, callback) {
  const cb = typeof values === 'function' ? values : (callback ?? config?.callback);
  const result = { rows: [], rowCount: 0, fields: [], command: 'SELECT' };
  if (cb) return void fromSocket(() => cb(null, result));
  return new Promise((resolve) => fromSocket(() => resolve(result)));
};

instrumentExpress(express);
instrumentPg(pg);

// --- The app --------------------------------------------------------------------

const pool = new pg.Pool({ max: 1 }); // one client: every request shares it

const app = express();
app.get('/nested', (req, res) => {
  const { id } = req.query;
  pool.query(`SELECT '${id}-outer'`, () => {
    pool.query(`SELECT '${id}-inner'`, [], () => res.end());
  });
});
app.get('/nested-client', (req, res) => {
  const { id } = req.query;
  pool.connect((err, client, release) => {
    client.query(`SELECT '${id}-held'`, () => {
      client.query({ text: `SELECT '${id}-again'`, callback: () => {
        release();
        res.end();
      } });
    });
  });
});

async function queriesOf(url) {
  const listening = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${listening.address().port}${url}`);
    await res.text();
    return JSON.parse(decodeURIComponent(res.headers.get('x-feel-route'))).queries;
  } finally {
    await new Promise((resolve) => listening.close(resolve));
  }
}

async function eachOwnsItsQueries(url, suffixes) {
  const ids = ['r0', 'r1', 'r2', 'r3'];
  const results = await Promise.all(ids.map((id) => queriesOf(`${url}?id=${id}`)));
  results.forEach((queries, n) => {
    assert.deepEqual(
      queries.map((q) => q.sql),
      suffixes.map((s) => `SELECT '${ids[n]}-${s}'`),
      `${url} ${ids[n]}`,
    );
  });
}

test('pg callback style: a query sent from a callback stays in its request', async () => {
  const queries = await queriesOf('/nested?id=r9');
  assert.deepEqual(
    queries.map((q) => q.sql),
    ["SELECT 'r9-outer'", "SELECT 'r9-inner'"],
  );
});

test('pg callback style on a one-client pool: parallel requests each get only their own queries', async () => {
  await eachOwnsItsQueries('/nested', ['outer', 'inner']);
});

test('pg pool.connect(callback) waiting for a client runs in the request that asked', async () => {
  await eachOwnsItsQueries('/nested-client', ['held', 'again']);
});

test.after(() => pool.end());
