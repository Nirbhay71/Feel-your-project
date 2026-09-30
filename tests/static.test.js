// Static "possible calls": component → API call → route → handler → SQL tables,
// from code alone. Run against the demo app (ES modules, aliases, React Query,
// SWR, axios instance) and a CommonJS fixture shaped like a typical Express app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { possibleCalls } from '../packages/agent/src/static.js';
import { resolveHandler } from '../packages/agent/src/handler.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function callsOf(rootDir, viteRoot, file, component) {
  const display = (abs) => path.relative(viteRoot, abs).split(path.sep).join('/');
  const calls = await possibleCalls({ abs: path.join(viteRoot, file), component, rootDir, display });
  return calls
    .map((c) => ({
      call: `${c.method} ${c.url}`,
      route: c.route && `${c.route.method} ${c.route.path}`,
      handler: c.route?.handler.name ?? null,
      tables: c.route?.queries.flatMap((q) => q.tables.map((t) => `${t.name}${t.access === 'write' ? '✎' : ''}`)).sort() ?? [],
    }))
    .sort((a, b) => a.call.localeCompare(b.call));
}

// --- Demo app ------------------------------------------------------------------

const DEMO = path.join(HERE, '..', 'demo');
const demo = (file, component) => callsOf(DEMO, DEMO, file, component);

test('demo: custom hook + fetch wrapper → controller in another file', async () => {
  assert.deepEqual(await demo('src/components/Dashboard.jsx', 'Dashboard'), [
    { call: 'GET /api/stats', route: 'GET /api/stats', handler: 'getStats', tables: ['orders', 'users'] },
  ]);
});

test('demo: React Query + axios instance (baseURL) → inline handler', async () => {
  assert.deepEqual(await demo('src/components/SalesChart.jsx', 'SalesChart'), [
    { call: 'GET /api/sales', route: 'GET /api/sales', handler: null, tables: ['orders'] },
  ]);
});

test('demo: SWR key + shared fetcher, and a not-yet-clicked DELETE with :id', async () => {
  assert.deepEqual(await demo('src/components/Notifications.jsx', 'Notifications'), [
    { call: 'DELETE /api/notifications/*', route: 'DELETE /api/notifications/:id', handler: null, tables: ['notifications✎'] },
    { call: 'GET /api/notifications', route: 'GET /api/notifications', handler: 'listNotifications', tables: ['notifications'] },
  ]);
});

test('demo: useMutation → handler → service two files away → two writes', async () => {
  assert.deepEqual(await demo('src/components/NewOrderButton.jsx', 'NewOrderButton'), [
    { call: 'POST /api/orders', route: 'POST /api/orders', handler: null, tables: ['notifications✎', 'orders✎', 'products', 'users'] },
  ]);
});

test('demo: route mounted through a package.json "#imports" alias keeps its /api prefix', async () => {
  assert.deepEqual(await demo('src/components/TopProducts.jsx', 'TopProducts'), [
    { call: 'GET /api/products/top', route: 'GET /api/products/top', handler: null, tables: ['orders', 'products'] },
  ]);
});

test('demo: a component that only receives props makes no calls', async () => {
  assert.deepEqual(await demo('src/components/StatCard.jsx', 'StatCard'), []);
});

// --- CommonJS fixture (client/ + server/ side by side) -----------------------------

const CJS = path.join(HERE, 'fixtures', 'cjs-app');
const cjs = (file, component) => callsOf(CJS, path.join(CJS, 'client'), file, component);

test('cjs: API object methods → routes mounted with require() → ctrl.x handlers', async () => {
  assert.deepEqual(await cjs('src/Items.jsx', 'Items'), [
    { call: 'GET /api/items', route: 'GET /api/items', handler: 'list', tables: ['items'] },
    { call: 'GET /api/items/*', route: 'GET /api/items/:id', handler: 'get', tables: ['items'] },
  ]);
});

test('cjs: destructured require + exports.x handler', async () => {
  assert.deepEqual(await cjs('src/Users.jsx', 'Users'), [
    { call: 'GET /api/users', route: 'GET /api/users', handler: 'listUsers', tables: ['users'] },
  ]);
});

test('cjs: route registration → the controller function that handles it', async () => {
  const route = path.join(CJS, 'server', 'routes', 'items.js');
  const target = await resolveHandler(route, 6, 0); // router.get('/:id', ctrl.get)
  assert.equal(path.relative(CJS, target.file).split(path.sep).join('/'), 'server/controllers/items.js');
  assert.equal(target.line, 8);
});

// --- ORM fixture (Prisma + Drizzle, no raw SQL) ------------------------------------

const ORM = path.join(HERE, 'fixtures', 'orm-app');
const orm = (file, component) => callsOf(ORM, path.join(ORM, 'client'), file, component);

test('orm: Drizzle chains, a namespace-imported schema, re-exports and db.query', async () => {
  assert.deepEqual(await orm('src/Orders.jsx', 'Orders'), [
    { call: 'GET /api/orders', route: 'GET /api/orders', handler: null, tables: ['app_users', 'orders'] },
    { call: 'GET /api/users/*', route: 'GET /api/users/:id', handler: null, tables: ['app_users'] },
    { call: 'POST /api/orders', route: 'POST /api/orders', handler: null, tables: ['orders✎', 'products✎'] },
  ]);
});

test('orm: Prisma models → tables from schema.prisma (@@map)', async () => {
  assert.deepEqual(await orm('src/Customers.jsx', 'Customers'), [
    { call: 'DELETE /api/customers/*', route: 'DELETE /api/customers/:id', handler: null, tables: ['customers✎', 'order_items✎'] },
    { call: 'GET /api/customers', route: 'GET /api/customers', handler: null, tables: ['customers'] },
  ]);
});

test('orm: one Drizzle chain is one query, labelled as written', async () => {
  const [call] = await possibleCalls({
    abs: path.join(ORM, 'client', 'src', 'Orders.jsx'),
    component: 'Orders',
    rootDir: ORM,
    display: (abs) => abs,
  });
  assert.equal(call.route.queries.length, 1);
  assert.match(call.route.queries[0].sql, /^db \.select\(\) \.from\(orders\) \.leftJoin\(users/);
});

// --- mysql2 fixture (raw pool.execute / pool.query, Drizzle's mysql2 driver) ----------

const MYSQL = path.join(HERE, 'fixtures', 'mysql-app');
const mysqlApp = (file, component) => callsOf(MYSQL, path.join(MYSQL, 'client'), file, component);

test('mysql: pool.execute and pool.query({ sql }) SQL; db.execute(sql`…`) and bus.execute are not raw SQL', async () => {
  assert.deepEqual(await mysqlApp('src/Users.jsx', 'Users'), [
    { call: 'GET /api/lookup', route: 'GET /api/lookup', handler: null, tables: ['products', 'users✎'] },
    { call: 'GET /api/stats', route: 'GET /api/stats', handler: null, tables: ['orders'] },
    { call: 'GET /api/users', route: 'GET /api/users', handler: null, tables: ['users'] },
  ]);
});
