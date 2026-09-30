// ORMs through @feel-dev/node, without a database: pg's network layer is
// replaced by a fake, everything above it (Drizzle, our patches, Express) is
// real. Each query must land in X-Feel-Route with the line of *your* code
// that asked for it — even though the ORM sends it later, from its own code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import * as pgCore from 'drizzle-orm/pg-core';
import * as pgRelational from 'drizzle-orm/pg-core/query-builders/query';
import { instrumentExpress, instrumentPg, instrumentDrizzle } from '../packages/node/src/index.js';

// --- A Postgres that answers everything with no rows ----------------------------
// Only the Client (one connection) is faked; the Pool is pg's real one.

pg.Client.prototype.connect = function (callback) {
  setImmediate(() => callback(null, this));
};
pg.Client.prototype.query = function (config, values, callback) {
  const cb = typeof values === 'function' ? values : callback;
  const result = { rows: [], rowCount: 0, fields: [], command: 'SELECT' };
  if (cb) return void setImmediate(() => cb(null, result));
  return Promise.resolve(result);
};

instrumentExpress(express);
instrumentPg(pg);
instrumentDrizzle({ dialects: [pgCore], relational: [pgRelational] });

// --- A stand-in for Prisma: a library in node_modules that reaches pg after a
// few awaits, many frames away from your code ------------------------------------

const libDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feel-orm-'));
const libFile = path.join(libDir, 'node_modules', 'fake-orm', 'index.mjs');
fs.mkdirSync(path.dirname(libFile), { recursive: true });
fs.writeFileSync(
  libFile,
  `
  const tick = () => new Promise((r) => setImmediate(r));
  async function engine(pool, sql, depth) {
    await tick();
    return depth ? await engine(pool, sql, depth - 1) : pool.query(sql);
  }
  export const orm = (pool) => ({ findMany: async (sql) => (await engine(pool, sql, 15)).rows });
  `,
);
const { orm } = await import(pathToFileURL(libFile));

// --- The app --------------------------------------------------------------------

const users = pgTable('users', { id: serial('id').primaryKey(), name: text('name') });
const pool = new pg.Pool();
const db = drizzle(pool, { schema: { users } });
const fakePrisma = orm(pool);

const app = express();
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
app.get('/deep', async (req, res) => {
  res.json(await fakePrisma.findMany('SELECT * FROM "public"."users"')); // DEEP_ORM
});

app.get('/pool', async (req, res) => {
  await pool.query('SELECT 1'); // POOL_QUERY
  res.end();
});

const THIS_FILE = fileURLToPath(import.meta.url);
const SOURCE = fs.readFileSync(THIS_FILE, 'utf8').split('\n');
const lineOf = (marker) => SOURCE.findIndex((l) => l.includes(`// ${marker}`)) + 1;

async function queriesOf(url) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
    return JSON.parse(decodeURIComponent(res.headers.get('x-feel-route'))).queries;
  } finally {
    server.close();
  }
}

test('drizzle: a lazy query gets the line that built it, not the one that sent it', async () => {
  const [q, ...rest] = await queriesOf('/drizzle');
  assert.equal(rest.length, 0);
  assert.match(q.sql, /^select .* from "users" where "users"\."id" = \$1$/);
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
  const [q] = await queriesOf('/drizzle-relational');
  assert.match(q.sql, /from "users"/);
  assert.equal(q.line, lineOf('DRIZZLE_RELATIONAL'));
});

test('deep ORM call (Prisma-style): the line is found through async frames', async () => {
  const [q] = await queriesOf('/deep');
  assert.equal(q.file, THIS_FILE);
  assert.equal(q.line, lineOf('DEEP_ORM'));
});

test('pool.query is recorded once, not again when pg-pool hands it to a Client', async () => {
  const queries = await queriesOf('/pool');
  assert.deepEqual(
    queries.map((q) => [q.sql, q.line]),
    [['SELECT 1', lineOf('POOL_QUERY')]],
  );
});

test.after(async () => {
  await pool.end();
  fs.rmSync(libDir, { recursive: true, force: true });
});
