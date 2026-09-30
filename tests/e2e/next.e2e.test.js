// End-to-end: a real `next dev` on tests/fixtures/next-app, driven by a real
// browser. Opt-in — it installs Next (a few hundred MB), needs Postgres and
// takes minutes:
//
//   FEEL_E2E=1 npm run test:e2e
//
// Env: FEEL_E2E_DATABASE_URL (default postgres://feel@127.0.0.1:5499/feel),
//      FEEL_E2E_CHROME (default: Playwright's Chromium in /opt/pw-browsers).
//
// Plain `npm test` picks this file up too and skips it. Nothing heavy is
// imported at the top: Playwright and pg come from the fixture's own
// node_modules, after the test installed them.
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
// Pass 3 checks everything but (e).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const APP = path.join(REPO, 'tests', 'fixtures', 'next-app');
const PACKS = path.join(APP, '.packs');
const DATABASE_URL = process.env.FEEL_E2E_DATABASE_URL ?? 'postgres://feel@127.0.0.1:5499/feel';
const UNREACHABLE_DB = 'postgres://feel@127.0.0.1:1/feel';
const CHROME = process.env.FEEL_E2E_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const skip = !process.env.FEEL_E2E && 'set FEEL_E2E=1 to run the Next.js end-to-end test';

test('Next.js end to end', { skip, timeout: 30 * 60_000 }, async (t) => {
  installFixture();
  await seedDatabase();
  const expected = expectedLines();

  await t.test('Turbopack', { timeout: 10 * 60_000 }, () => runPass({ bundler: 'turbopack', database: DATABASE_URL, expected }));
  await t.test('webpack', { timeout: 10 * 60_000 }, () => runPass({ bundler: 'webpack', database: DATABASE_URL, expected }));
  await t.test('Turbopack, database unreachable', { timeout: 10 * 60_000 }, () =>
    runPass({ bundler: 'turbopack', database: UNREACHABLE_DB, expected, dbDown: true }),
  );
});

// --- Setup ---------------------------------------------------------------------

// Feel is installed from packed tarballs, like a user gets it from npm. A
// symlink to the repo would resolve pg from the repo's node_modules — a
// different copy than the app's, so no query would ever be seen.
function installFixture() {
  fs.rmSync(PACKS, { recursive: true, force: true });
  fs.mkdirSync(PACKS);
  const packages = ['agent', 'client', 'node', 'next'];
  execFileSync(NPM, ['pack', ...packages.flatMap((p) => ['-w', `@feel-dev/${p}`]), '--pack-destination', PACKS], { cwd: REPO, stdio: 'ignore' });
  const tarballs = fs.readdirSync(PACKS).map((f) => `./.packs/${f}`);
  execFileSync(NPM, ['install', '--no-save', '--no-audit', '--no-fund', '--no-package-lock', ...tarballs], { cwd: APP, stdio: 'inherit' });
  // npm must have used our tarballs, not a published @feel-dev/node from the registry.
  assert.ok(fs.existsSync(path.join(APP, 'node_modules', '@feel-dev', 'node', 'src', 'next.js')), 'tarball of @feel-dev/node installed');
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
    const res = await fetch(`${server.url}/api/items`);
    const route = JSON.parse(decodeURIComponent(res.headers.get('x-feel-route') ?? 'null'));
    assert.ok(route, `X-Feel-Route header present (${bundler})`);
    assert.equal(route.path, '/api/items');
    assert.equal(route.handlers[0].name, 'GET');
    assert.equal(route.handlers[0].line, expected.handler);

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
    assert.ok(handler.title.replace(/\\/g, '/').endsWith(`app/api/items/route.ts:${expected.handler}`), `(d) handler location: ${handler.title}`);

    // (e) the SQL, from the route file, with its table
    if (!dbDown) {
      const query = req.database.find((d) => d.sql.includes('FROM items'));
      assert.ok(query, `(e) query row: ${JSON.stringify(req.database)}`);
      assert.ok(query.site.replace(/\\/g, '/').endsWith(`app/api/items/route.ts:${expected.query}`), `(e) query sent from: ${query.site}`);
      assert.ok(!query.site.includes('.next'), '(e) not a bundle path');
      assert.ok(query.tables.includes('items'), `(e) table items: ${query.tables}`);
    }

    // (f) the button's POST, found statically
    const post = panel.possible.find((p) => p.head.includes('POST /api/items/*'));
    assert.ok(post, `(f) possible POST: ${JSON.stringify(panel.possible.map((p) => p.head))}`);
    assert.ok(post.backendText.includes('POST /api/items/:id'), `(f) route: ${post.backendText}`);
    assert.ok(post.handlers.some((h) => h.replace(/\\/g, '/').endsWith(`app/api/items/[id]/route.ts:${expected.postHandler}`)), `(f) handler: ${post.handlers}`);

    // (g) server and browser rendered the same data-src tags
    const hydration = consoleErrors.filter((m) => /hydrat/i.test(m));
    assert.deepEqual(hydration, [], '(g) no hydration mismatch');
  } catch (err) {
    err.message += `\n--- next dev output (${bundler}) ---\n${server.output().slice(-4000)}`;
    throw err;
  } finally {
    await browser?.close();
    await server.stop();
  }
}

// The panel's text, read out of its shadow DOM.
async function waitForPanel(page, ready) {
  const deadline = Date.now() + 120_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(readPanel);
    if (last && ready(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
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

// --- next dev --------------------------------------------------------------------

async function startNext(bundler, database) {
  const port = await freePort();
  const args = [path.join('node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-p', String(port)];
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

  const stop = async () => {
    try {
      if (process.platform === 'win32') child.kill();
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  };

  const deadline = Date.now() + 120_000;
  while (!/Ready in/.test(output)) {
    if (Date.now() > deadline || child.exitCode != null) {
      await stop();
      throw new Error(`next dev didn't start (${bundler}):\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { url: `http://localhost:${port}`, output: () => output, stop };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
