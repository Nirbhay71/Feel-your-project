// End-to-end: a real `next dev` on a copy of tests/fixtures/next-app, driven
// by a real browser. Opt-in — it installs Next (a few hundred MB), needs
// Postgres and takes minutes:
//
//   FEEL_E2E=1 npm run test:e2e
//
// Env: FEEL_E2E_DATABASE_URL (default postgres://feel@127.0.0.1:5499/feel),
//      FEEL_E2E_CHROME (default: Playwright's Chromium in /opt/pw-browsers),
//      FEEL_E2E_DIR (where the copy lives; default <tmp>/feel-next-e2e —
//      kept between runs so Next is only installed once).
//
// Plain `npm test` picks this file up too and skips it. Nothing heavy is
// imported at the top: Playwright and pg come from the copy's own
// node_modules, after the test installed them. The fixture itself is only
// read, so a run leaves the repository as it was.
//
// Three passes, one after another (Next refuses two dev servers in one folder):
//   1. Turbopack (the default in Next 16)   2. webpack (--webpack)
//   3. Turbopack with the database unreachable
// Each Alt + right-clicks an item and checks the panel:
//   (a) the <li> has a data-src tag        (b) chain Dashboard → ItemList, at the <ItemList /> line
//   (c) GET /api/items from loadItems at the right line of lib/api.js
//   (d) Backend: handler GET in app/api/items/route.ts at its line
//   (e) Database: the SQL, sent from route.ts (not .next/…), table items
//   (f) possible call POST /api/items/* → app/api/items/[id]/route.ts
//   (g) no hydration mismatch in the console
// and (h) the agent refuses another machine, even with Host: localhost.
// Passes 1 and 2 then edit route.ts and lib/api.js while the page is open
// and check (i) the SQL call site and the browser frames follow the edit.
// Pass 3 checks everything but (e) and (i).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'next-app');
const APP = path.resolve(process.env.FEEL_E2E_DIR ?? path.join(os.tmpdir(), 'feel-next-e2e'));
const PACKS = path.join(APP, '.packs');
const DATABASE_URL = process.env.FEEL_E2E_DATABASE_URL ?? 'postgres://feel@127.0.0.1:5499/feel';
const UNREACHABLE_DB = 'postgres://feel@127.0.0.1:1/feel';
const CHROME = process.env.FEEL_E2E_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// Never copied from the fixture: installed or generated there by hand.
const NOT_COPIED = new Set(['node_modules', '.next', '.packs', 'package-lock.json', 'next-env.d.ts', 'AGENTS.md', 'CLAUDE.md']);

const skip = !process.env.FEEL_E2E && 'set FEEL_E2E=1 to run the Next.js end-to-end test';

test('Next.js end to end', { skip, timeout: 30 * 60_000 }, async (t) => {
  copyFixture();
  installFeel();
  await seedDatabase();
  const expected = expectedLines();

  await t.test('Turbopack', { timeout: 10 * 60_000 }, () => runPass({ bundler: 'turbopack', database: DATABASE_URL, expected }));
  await t.test('webpack', { timeout: 10 * 60_000 }, () => runPass({ bundler: 'webpack', database: DATABASE_URL, expected }));
  await t.test('Turbopack, database unreachable', { timeout: 10 * 60_000 }, () =>
    runPass({ bundler: 'turbopack', database: UNREACHABLE_DB, expected, dbDown: true }),
  );
});

// --- Setup ---------------------------------------------------------------------

// A fresh copy of the fixture's sources; the copy's node_modules stay from
// the last run, so Next is only downloaded once.
function copyFixture() {
  fs.mkdirSync(APP, { recursive: true });
  for (const entry of fs.readdirSync(APP)) if (entry !== 'node_modules') fs.rmSync(path.join(APP, entry), { recursive: true, force: true });
  for (const entry of fs.readdirSync(FIXTURE)) {
    if (!NOT_COPIED.has(entry)) fs.cpSync(path.join(FIXTURE, entry), path.join(APP, entry), { recursive: true });
  }
}

// Feel is installed from packed tarballs, like a user gets it from npm. A
// symlink to the repo would resolve pg from the repo's node_modules — a
// different copy than the app's, so no query would ever be seen.
function installFeel() {
  fs.mkdirSync(PACKS);
  const packages = ['agent', 'client', 'node', 'next'];
  execFileSync(NPM, ['pack', ...packages.flatMap((p) => ['-w', `@feel-dev/${p}`]), '--pack-destination', PACKS], { cwd: REPO, stdio: 'ignore' });
  const tarballs = fs.readdirSync(PACKS).map((f) => `./.packs/${f}`);
  execFileSync(NPM, ['install', '--no-save', '--no-audit', '--no-fund', '--no-package-lock', ...tarballs], { cwd: APP, stdio: 'inherit' });
  // npm must have used our tarballs, not a published @feel-dev/next from the registry.
  assert.ok(fs.existsSync(path.join(APP, 'node_modules', '@feel-dev', 'next', 'src', 'peer.js')), 'tarball of @feel-dev/next installed');
}

async function seedDatabase() {
  const pg = createRequire(path.join(APP, 'package.json'))('pg');
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query('DROP TABLE IF EXISTS items');
    await client.query('CREATE TABLE items (id serial PRIMARY KEY, name text NOT NULL)');
    await client.query("INSERT INTO items (name) VALUES ('apple'), ('banana'), ('cherry')");
  } finally {
    await client.end();
  }
}

// The lines the panel should point at, found in the fixture's own sources
// so editing the fixture doesn't silently break the test.
function expectedLines() {
  const lineOf = (file, needle) => {
    const lines = fs.readFileSync(path.join(APP, file), 'utf8').split('\n');
    const i = lines.findIndex((l) => l.includes(needle));
    assert.ok(i >= 0, `${needle} in ${file}`);
    return i + 1;
  };
  return {
    usage: lineOf('components/Dashboard.jsx', '<ItemList />'),
    fetch: lineOf('lib/api.js', "fetch('/api/items')"),
    rename: lineOf('lib/api.js', "fetch('/api/items/' + id"),
    handler: lineOf('app/api/items/route.ts', 'export async function GET'),
    query: lineOf('app/api/items/route.ts', 'pool.query('),
    postHandler: lineOf('app/api/items/[id]/route.ts', 'export async function POST'),
  };
}

// --- One pass --------------------------------------------------------------------

async function runPass({ bundler, database, expected, dbDown = false }) {
  fs.rmSync(path.join(APP, '.next'), { recursive: true, force: true });
  const server = await startNext(bundler, database);
  let browser;
  try {
    // The header on its own, before any browser is involved.
    const route = await routeHeader(server.url);
    assert.ok(route, `X-Feel-Route header present (${bundler})`);
    assert.equal(route.path, '/api/items');
    assert.equal(route.handlers[0].name, 'GET');
    assert.equal(route.handlers[0].line, expected.handler);

    await assertOtherMachinesRefused(server.port);

    const { chromium } = createRequire(path.join(APP, 'package.json'))('playwright-core');
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-proxy-server'] });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await page.goto(server.url, { waitUntil: 'load', timeout: 180_000 });
    const li = page.locator('li').first();
    await li.waitFor({ timeout: 180_000 });

    // (a) the element carries its source location
    const dataSrc = await li.getAttribute('data-src');
    assert.match(dataSrc ?? '', /^components\/ItemList\.jsx:\d+:\d+\|ItemList$/, `(a) data-src on <li>: ${dataSrc}`);

    await li.click({ button: 'right', modifiers: ['Alt'] });
    const panel = await waitForPanel(page, (p) => p.requests.some((r) => r.head.includes('GET /api/items') && r.frontend.length) && p.possible.length);

    if (process.env.FEEL_E2E_VERBOSE) console.log(bundler, JSON.stringify(panel, null, 1), consoleErrors);
    // (b) component chain, Dashboard's entry at the line that renders <ItemList />
    const names = panel.chain.map((c) => c.name);
    assert.deepEqual(names.slice(-2), ['Dashboard', 'ItemList'], `(b) chain: ${names.join(' › ')}`);
    assert.equal(panel.chain.at(-2).title, `components/Dashboard.jsx:${expected.usage}`, '(b) Dashboard entry points at <ItemList />');

    // (c) the request, made by loadItems at its fetch() line
    const req = panel.requests.find((r) => r.head.includes('GET /api/items'));
    const load = req.frontend.find((f) => f.text === 'loadItems');
    assert.ok(load, `(c) loadItems in the frontend chain: ${JSON.stringify(req.frontend)}`);
    assert.equal(load.title, `lib/api.js:${expected.fetch}`, '(c) loadItems frame at the fetch line');

    // (d) the route handler
    const handler = req.backend.find((b) => b.text === 'GET');
    assert.ok(handler, `(d) handler GET: ${JSON.stringify(req.backend)}`);
    assert.ok(slash(handler.title).endsWith(`app/api/items/route.ts:${expected.handler}`), `(d) handler location: ${handler.title}`);

    // (e) the SQL, from the route file, with its table
    if (!dbDown) {
      const query = req.database.find((d) => d.sql.includes('FROM items'));
      assert.ok(query, `(e) query row: ${JSON.stringify(req.database)}`);
      assert.ok(slash(query.site).endsWith(`app/api/items/route.ts:${expected.query}`), `(e) query sent from: ${query.site}`);
      assert.ok(!query.site.includes('.next'), '(e) not a bundle path');
      assert.ok(query.tables.includes('items'), `(e) table items: ${query.tables}`);
    }

    // (f) the button's POST, found statically
    const post = panel.possible.find((p) => p.head.includes('POST /api/items/*'));
    assert.ok(post, `(f) possible POST: ${JSON.stringify(panel.possible.map((p) => p.head))}`);
    assert.ok(post.backendText.includes('POST /api/items/:id'), `(f) route: ${post.backendText}`);
    assert.ok(post.handlers.some((h) => slash(h).endsWith(`app/api/items/[id]/route.ts:${expected.postHandler}`)), `(f) handler: ${post.handlers}`);

    // (g) server and browser rendered the same data-src tags
    const hydration = consoleErrors.filter((m) => /hydrat/i.test(m));
    assert.deepEqual(hydration, [], '(g) no hydration mismatch');

    if (!dbDown) await hotReloadStep({ page, server, expected, bundler });
  } catch (err) {
    err.message += `\n--- next dev output (${bundler}) ---\n${server.output().slice(-4000)}`;
    throw err;
  } finally {
    restoreEdits();
    await browser?.close();
    await server.stop();
  }
}

// (h) next dev listens on the whole network; the agent must not. Reached
// through this machine's own LAN address, the connection isn't loopback —
// exactly what another machine looks like — and Host: localhost can't hide it.
async function assertOtherMachinesRefused(port) {
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!lan) return; // no network interface to try it on
  const status = await new Promise((resolve, reject) => {
    const socket = net.connect(port, lan.address, () => {
      socket.write(`GET /__feel/source?file=app/api/items/route.ts&line=1 HTTP/1.1\r\nHost: localhost:${port}\r\nX-Forwarded-For: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (d) => (data += d));
    socket.on('end', () => resolve(Number(data.split(' ')[1])));
    socket.on('error', reject);
  });
  assert.equal(status, 403, `(h) request from ${lan.address} with Host: localhost refused`);
}

// --- Hot reload ------------------------------------------------------------------

const EDITED = ['app/api/items/route.ts', 'lib/api.js'];
const originals = new Map();
const PREPENDED = '// edited by the end-to-end test\n// (two lines, so everything below moves down)\n';

function editFiles() {
  for (const rel of EDITED) {
    const file = path.join(APP, rel);
    const code = fs.readFileSync(file, 'utf8');
    originals.set(file, code);
    fs.writeFileSync(file, PREPENDED + code);
  }
}

function restoreEdits() {
  for (const [file, code] of originals) fs.writeFileSync(file, code);
  originals.clear();
}

// (i) With the page still open, both files gain two lines at the top. The
// route handler is rebuilt (Turbopack runs its new code as chunk.js?<id>)
// and the browser swaps lib/api.js in place (Turbopack: …chunk.js?id=…).
// The SQL call site and the Rename button's frame must follow.
async function hotReloadStep({ page, server, expected, bundler }) {
  editFiles();
  const shift = PREPENDED.split('\n').length - 1;

  // Server: wait for the rebuilt handler, then check where its SQL is sent from.
  const deadline = Date.now() + 120_000;
  let route = null;
  while (Date.now() < deadline) {
    route = await routeHeader(server.url).catch(() => null);
    if (route?.handlers[0].line === expected.handler + shift) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(route?.handlers[0].line, expected.handler + shift, `(i) ${bundler}: rebuilt handler reports its new line`);
  const query = route.queries.find((q) => q.sql.includes('FROM items'));
  assert.ok(query, `(i) query recorded after the edit: ${JSON.stringify(route.queries)}`);
  assert.ok(slash(query.file).endsWith('app/api/items/route.ts') && query.line === expected.query + shift, `(i) ${bundler}: SQL sent from ${query.file}:${query.line}`);

  // Browser: once the new lib/api.js is in, Rename calls its renameItem.
  await page.waitForFunction(() => document.querySelector('li button'), null, { timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 3000)); // let the hot update land
  await page.locator('li button').first().click();
  const li = page.locator('li').first();
  await li.click({ button: 'right', modifiers: ['Alt'] });
  const want = `lib/api.js:${expected.rename + shift}`;
  const panel = await waitForPanel(page, (p) => p.requests.some((r) => r.head.includes('POST /api/items/') && r.frontend.some((f) => f.title === want)), { soft: true });
  const post = panel?.requests.find((r) => r.head.includes('POST /api/items/'));
  assert.ok(post?.frontend.some((f) => f.text === 'renameItem' && f.title === want), `(i) ${bundler}: renameItem at ${want} after the edit: ${JSON.stringify(post?.frontend)}`);
}

// --- Panel -----------------------------------------------------------------------

// The panel's text, read out of its shadow DOM.
async function waitForPanel(page, ready, { soft = false } = {}) {
  const deadline = Date.now() + 120_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(readPanel);
    if (last && ready(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (soft) return last;
  assert.fail(`panel never showed the request and possible calls: ${JSON.stringify(last)}`);
}

// Runs in the browser.
function readPanel() {
  const root = document.querySelector('feel-panel')?.shadowRoot;
  if (!root?.querySelector('.panel.open')) return null;
  const buttons = (row, cls) => [...row.querySelectorAll(`button.${cls}`)].map((b) => ({ text: b.textContent, title: b.title }));
  const hop = (req, tag) => [...req.querySelectorAll('.hop')].filter((h) => h.querySelector('.tag')?.textContent === tag);
  const database = (req) =>
    hop(req, 'Database').map((h) => ({
      site: h.querySelector('button.be')?.title.replace(/^Query sent from /, '') ?? '',
      sql: h.querySelector('code.sql')?.textContent ?? '',
      tables: [...h.querySelectorAll('button.db')].map((b) => b.textContent.replace(' ✎', '')),
    }));
  const reqs = [...root.querySelectorAll('.flow .req')];
  return {
    chain: [...root.querySelectorAll('nav button')].map((b) => ({ name: b.textContent, title: b.title })),
    requests: reqs
      .filter((r) => !r.classList.contains('possible'))
      .map((r) => ({
        head: r.querySelector('.req-head')?.textContent ?? '',
        frontend: hop(r, 'Frontend').flatMap((h) => buttons(h, 'fe')),
        backend: hop(r, 'Backend').flatMap((h) => buttons(h, 'be')),
        database: database(r),
      })),
    possible: reqs
      .filter((r) => r.classList.contains('possible'))
      .map((r) => ({
        head: r.querySelector('.req-head')?.textContent ?? '',
        backendText: hop(r, 'Backend')[0]?.textContent ?? '',
        handlers: hop(r, 'Backend').flatMap((h) => buttons(h, 'be').map((b) => b.title)),
      })),
  };
}

const slash = (p) => p.replace(/\\/g, '/');

async function routeHeader(url) {
  const res = await fetch(`${url}/api/items`);
  return JSON.parse(decodeURIComponent(res.headers.get('x-feel-route') ?? 'null'));
}

// --- next dev --------------------------------------------------------------------

async function startNext(bundler, database) {
  // Listens on every interface (next dev's default) so (h) can knock from
  // the LAN address; the URL is read from Next's own "Local:" line.
  const args = [path.join('node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-H', '0.0.0.0', '-p', String(await freePort())];
  if (bundler === 'webpack') args.push('--webpack');
  const child = spawn(process.execPath, args, {
    cwd: APP,
    detached: process.platform !== 'win32', // own process group, so stop() gets its workers too
    env: { ...process.env, DATABASE_URL: database, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((resolve) => child.once('exit', resolve));

  const signal = (name) => {
    try {
      if (process.platform === 'win32') child.kill(name);
      else process.kill(-child.pid, name);
    } catch {
      // already gone
    }
  };
  const stop = async () => {
    signal('SIGTERM');
    const done = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 10_000))]);
    if (!done) {
      signal('SIGKILL'); // a worker that ignored SIGTERM would hold the port and the folder
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    }
  };

  const deadline = Date.now() + 120_000;
  while (!/Ready in/.test(output)) {
    if (Date.now() > deadline || child.exitCode != null) {
      await stop();
      throw new Error(`next dev didn't start (${bundler}):\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  const port = Number(output.match(/Local:\s+https?:\/\/[^\s:]+:(\d+)/)?.[1]);
  assert.ok(port, `port in next dev's output:\n${output}`);
  return { url: `http://localhost:${port}`, port, output: () => output, stop };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
