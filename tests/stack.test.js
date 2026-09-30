// Browser stack traces → your source lines (@feel-dev/agent's stack.js), with
// Vite's locator and with Next's (@feel-dev/next's locator.js), which fetches
// Turbopack chunk maps and webpack module maps from the dev server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import MagicString from 'magic-string';
import { resolveStack, viteFrameLocator } from '../packages/agent/src/stack.js';
import { createNextLocator, normalizeSource } from '../packages/next/src/locator.js';

// A tiny app on disk: resolveStack reads the files to name functions.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'feel-stack-'));
const API = `// helpers
export async function loadItems() {
  const res = await fetch('/api/items');
  return res.json();
}
`;
const LIST = `export default function List() {
  loadItems();
  return null;
}
`;
fs.mkdirSync(path.join(ROOT, 'lib'));
fs.mkdirSync(path.join(ROOT, 'components'));
fs.writeFileSync(path.join(ROOT, 'lib', 'api.js'), API);
fs.writeFileSync(path.join(ROOT, 'components', 'List.jsx'), LIST);
const display = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

// A sourcemap for `code` moved down by `shift` lines in the bundle.
function mapOf(code, source, shift = 0) {
  const s = new MagicString(code);
  if (shift) s.prepend('\n'.repeat(shift));
  return s.generateMap({ hires: true, source, includeContent: true });
}

const summary = (frames) => frames.map((f) => (f.lib !== undefined ? `[${f.lib}]` : `${f.fn ?? f.component}@${f.file}:${f.line}`));

test('Vite locator: mapped module frames, library marker between your frames', async () => {
  const modules = {
    '/lib/api.js': { file: path.join(ROOT, 'lib', 'api.js'), map: mapOf(API, 'api.js', 5) },
    '/components/List.jsx': { file: path.join(ROOT, 'components', 'List.jsx'), map: null },
  };
  const stack = `Error
    at loadItems (http://localhost:5173/lib/api.js?t=123:8:21)
    at run (http://localhost:5173/node_modules/.vite/deps/swr.js?v=1:10:3)
    at List (http://localhost:5173/components/List.jsx:2:3)
    at x (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1:1:1)`;
  const frames = await resolveStack(stack, { locate: viteFrameLocator(async (url) => modules[url.split('?')[0]]), display });
  assert.deepEqual(summary(frames), ['loadItems@lib/api.js:3', '[swr]', 'List@components/List.jsx:2']);
});

test('Next locator, Turbopack: sectioned chunk map, library section, always fetched from the request origin', async () => {
  const lib = 'function fetcher(f) {\n  return f();\n}\n';
  const chunkMap = {
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: mapOf(API, pathToFileURL(path.join(ROOT, 'lib', 'api.js')).href, 2) },
      { offset: { line: 100, column: 0 }, map: mapOf(lib, pathToFileURL(path.join(ROOT, 'node_modules', 'swr', 'dist', 'index.js')).href) },
      { offset: { line: 200, column: 0 }, map: mapOf(LIST, pathToFileURL(path.join(ROOT, 'components', 'List.jsx')).href) },
      { offset: { line: 300, column: 0 }, map: mapOf(lib, 'turbopack:///[turbopack]/browser/runtime.ts') },
    ],
  };
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(url);
    return url.endsWith('/_next/static/chunks/app.js.map') ? new Response(JSON.stringify(chunkMap)) : new Response('', { status: 404 });
  };
  const locate = createNextLocator({ root: ROOT, fetch });
  const stack = `Error
    at loadItems (http://evil.example:3000/_next/static/chunks/app.js:5:21)
    at fetcher (http://localhost:3000/_next/static/chunks/app.js:102:10)
    at List (http://localhost:3000/_next/static/chunks/app.js:202:3)
    at runtime (http://localhost:3000/_next/static/chunks/app.js:301:1)
    at react (http://localhost:3000/_next/static/chunks/node_modules_react-dom_1234._.js:1:1)
    at other (http://localhost:3000/somewhere/else.js:1:1)`;
  const frames = await resolveStack(stack, { locate, display, context: { origin: 'http://localhost:3000' } });
  assert.deepEqual(summary(frames), ['loadItems@lib/api.js:3', '[swr]', 'List@components/List.jsx:2']);
  assert.deepEqual([...new Set(fetched)], ['http://localhost:3000/_next/static/chunks/app.js.map'], 'one map, from the request origin only');
});

test('Next locator, webpack: webpack-internal frames go to /__nextjs_source-map by their raw name', async () => {
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(url);
    const name = new URL(url).searchParams.get('filename');
    if (name === 'webpack-internal:///(app-pages-browser)/./lib/api.js') return new Response(JSON.stringify(mapOf(API, 'webpack://_N_E/./lib/api.js?4a2b', 3)));
    if (name === 'webpack-internal:///(app-pages-browser)/./components/List.jsx') return new Response(JSON.stringify(mapOf(LIST, 'webpack://./components/List.jsx')));
    return new Response(null, { status: 204 });
  };
  const locate = createNextLocator({ root: ROOT, fetch });
  const stack = `Error
    at window.fetch (webpack-internal:///(app-pages-browser)/./node_modules/@feel-dev/client/src/network.js:130:20)
    at loadItems (webpack-internal:///(app-pages-browser)/./lib/api.js:6:21)
    at feel (webpack-internal:///(app-pages-browser)/./node_modules/@feel-dev/client/src/network.js:12:1)
    at List (webpack-internal:///(app-pages-browser)/./components/List.jsx:2:3)`;
  const frames = await resolveStack(stack, { locate, display, context: { origin: 'http://localhost:3000' } });
  assert.deepEqual(summary(frames), ['loadItems@lib/api.js:3', 'List@components/List.jsx:2'], '@feel-dev/client is never shown as a library');
  assert.equal(fetched[0], `http://localhost:3000/__nextjs_source-map?filename=${encodeURIComponent('webpack-internal:///(app-pages-browser)/./lib/api.js')}`);
  assert.ok(!fetched.some((u) => u.includes('node_modules')), 'package frames are never fetched');
});

test('Next locator: no origin, or a map that is not there → frame skipped', async () => {
  const locate = createNextLocator({ root: ROOT, fetch: async () => new Response('nope', { status: 500 }) });
  assert.equal(await locate('http://localhost:3000/_next/static/chunks/a.js', 1, 1, {}), null);
  assert.equal(await locate('http://localhost:3000/_next/static/chunks/a.js', 1, 1, { origin: 'http://localhost:3000' }), null);
});

test('normalizeSource: map source names → files', () => {
  const root = path.resolve('/app');
  const at = (rel) => path.join(root, rel);
  assert.equal(normalizeSource(pathToFileURL(at('lib/api.js')).href, root), at('lib/api.js'));
  assert.equal(normalizeSource('turbopack:///[project]/lib/api.js', root), at('lib/api.js'));
  assert.equal(normalizeSource('turbopack:///[turbopack]/browser/runtime.ts', root), null);
  assert.equal(normalizeSource('webpack://_N_E/./lib/api.js?1234', root), at('lib/api.js'));
  assert.equal(normalizeSource('webpack://./lib/api.js', root), at('lib/api.js'));
  assert.equal(normalizeSource('webpack://_N_E/lib/api.js', root), at('lib/api.js'));
  assert.equal(normalizeSource('webpack-internal:///(app-pages-browser)/./lib/api.js', root), at('lib/api.js'));
  assert.equal(normalizeSource('webpack://javascript/auto|./node_modules/react-dom/cjs/react-dom.js|app-pages-browser', root), at('node_modules/react-dom/cjs/react-dom.js'));
  assert.equal(normalizeSource('webpack://next/src/client/index.ts', root), null);
  assert.equal(normalizeSource('webpack://_N_E/webpack/runtime/jsonp', root), null);
  assert.equal(normalizeSource('relative/thing.js', root), null);
});

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
