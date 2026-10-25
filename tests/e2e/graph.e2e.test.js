// No database required. Exercise the real Vite plugin, network capture, panel
// and graph in Chromium while controlling the app API and optional metadata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const enabled = process.env.FEEL_BROWSER_E2E === '1';
test('graph browser regression checks', { skip: !enabled && 'set FEEL_BROWSER_E2E=1 to run', timeout: 120000 }, async (t) => {
  const [{ chromium }, { createServer }, { default: react }, { default: feel }] = await Promise.all([
    import('playwright'), import('vite'), import('@vitejs/plugin-react'), import('../../packages/vite-plugin/src/index.js'),
  ]);
  const root = fileURLToPath(new URL('../fixtures/browser-app/', import.meta.url));
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'feel-browser-cache-'));
  const cacheDir = path.join(cacheRoot, 'node_modules', '.vite');
  const server = await createServer({ configFile: false, root, cacheDir, plugins: [feel({ projectRoot: root }), react()], server: { host: '127.0.0.1', port: 5178 } });
  await server.listen();
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'chromium' });
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    const backend = { method: 'GET', path: '/api/users', handlers: [], queries: [{ sql: 'SELECT * FROM users', tables: [{ name: 'users', access: 'read' }], duration: 1 }] };
    const metadata = { name: 'users', rowCount: 2, columns: [], primaryKey: [], references: [], referencedBy: [], changes: [] };
    const pageErrors = new WeakMap();
    let scenario = 0;
    const finish = async (page) => {
      try {
        const output = path.resolve('test-results');
        await fs.mkdir(output, { recursive: true });
        const name = `graph-${++scenario}`;
        await page.screenshot({ path: path.join(output, name + '.png') });
        const state = await page.evaluate(() => ({
          flow: document.querySelector('feel-panel')?.shadowRoot?.querySelector('.flow')?.textContent,
          requests: window.__feel?.requests?.map((r) => ({ url: r.url, status: r.status, backend: !!r.backend, frames: r.frames })),
        }));
        await fs.writeFile(path.join(output, name + '.json'), JSON.stringify({ ...state, errors: pageErrors.get(page) }, null, 2));
        assert.deepEqual(pageErrors.get(page), [], 'No uncaught browser errors');
      } finally { await page.close(); }
    };
    const prepare = async () => {
      const page = await browser.newPage();
      const errors = [];
      pageErrors.set(page, errors);
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.route('**/api/users', (route) => route.fulfill({ status: 200, body: '[]', headers: { 'X-Feel-Route': encodeURIComponent(JSON.stringify(backend)) } }));
      await page.route('https://project.supabase.co/**', (route) => route.fulfill({ status: 200, body: '[]', headers: { 'access-control-allow-origin': '*' } }));
      await page.goto(base);
      await page.getByText('Ready', { exact: true }).waitFor();
      return page;
    };
    const open = async (page) => {
      await page.getByRole('heading', { name: 'Users', exact: true }).click({ button: 'right', modifiers: ['Alt'] });
      await page.getByRole('button', { name: 'Graph', exact: true }).click();
    };
    const visibleGraph = async (page) => {
      await page.locator('feel-panel .gnode').first().waitFor({ state: 'visible' });
      assert.ok(await page.locator('feel-panel .graph').isVisible());
      const box = await page.locator('feel-panel .graph').evaluate((e) => ({ width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height }));
      assert.ok(box.width > 0 && box.height > 0);
    };

    await t.test('graph is visible before database details resolve and stays usable across modes', async () => {
      const page = await prepare();
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      await page.route('**/__feel/db/table?*', async (route) => { await gate; await route.fulfill({ json: metadata }); });
      try {
        await open(page);
        await visibleGraph(page);
        await page.locator('feel-panel .gnode.table').filter({ hasText: 'users' }).waitFor();
        await page.getByRole('button', { name: 'List', exact: true }).click();
        await page.getByRole('button', { name: 'Graph', exact: true }).click();
        await visibleGraph(page);
        release();
        await page.locator('feel-panel .gnode.table').filter({ hasText: '2 rows' }).waitFor();
      } finally { release(); await finish(page); }
    });

    await t.test('analysis failures offer Retry and recover on the same component', async () => {
      const page = await prepare();
      let fail = true;
      await page.route('**/__feel/reach?*', (route) => fail ? route.fulfill({ status: 503, body: '{}' }) : route.continue());
      try {
        await open(page);
        await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
        fail = false;
        await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await visibleGraph(page);
      } finally { await finish(page); }
    });

    await t.test('components without API calls retain a visible graph and guidance', async () => {
      const page = await prepare();
      try {
        await page.getByRole('heading', { name: 'Details', exact: true }).click({ button: 'right', modifiers: ['Alt'] });
        await page.getByRole('button', { name: 'Graph', exact: true }).click();
        await visibleGraph(page);
        assert.equal(await page.locator('feel-panel .gnode').count(), 1);
        await page.locator('feel-panel .empty').filter({ hasText: 'No API calls detected yet' }).waitFor();
      } finally { await finish(page); }
    });

    await t.test('Supabase graph keeps its table link with an unavailable database', async () => {
      const page = await prepare();
      await page.route('**/__feel/db/table?*', (route) => route.fulfill({ status: 503, json: { error: 'Database unavailable' } }));
      try {
        await page.getByRole('button', { name: 'Read Supabase', exact: true }).click();
        await open(page);
        await page.locator('feel-panel .gnode.route').filter({ hasText: 'Supabase select' }).waitFor();
        await visibleGraph(page);
        await page.locator('feel-panel .gnode.table').filter({ hasText: 'users' }).click();
        await page.getByText('Database unavailable', { exact: true }).waitFor();
      } finally { await finish(page); }
    });

    await t.test('setup checks report agent availability and observed backend metadata', async () => {
      const page = await prepare();
      try {
        await open(page);
        await page.getByText('Setup checks', { exact: true }).click();
        await page.locator('feel-panel .check').filter({ hasText: 'Feel agent · ok' }).waitFor();
        await page.locator('feel-panel .check').filter({ hasText: 'No database configured' }).waitFor();
        await page.locator('feel-panel .check').filter({ hasText: 'Backend instrumentation · ok' }).waitFor();
        await page.route('**/__feel/diagnostics', (route) => route.fulfill({ status: 503, body: '{}' }));
        await page.getByRole('button', { name: 'Refresh checks', exact: true }).click();
        await page.locator('feel-panel .check').filter({ hasText: 'Feel agent · error' }).waitFor();
      } finally { await finish(page); }
    });
  } finally {
    await browser?.close();
    await server.close();
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }
});
