// Route handler instrumentation for Next.js: the loader's rewrite of a route
// file (@feel-dev/next's wrap-route.js) and the runtime wrappers it calls
// (@feel-dev/node's next.js), which run each handler in its request context
// and report it in the X-Feel-Route header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { wrapRoute } from '../packages/next/src/wrap-route.js';
import { parseCode } from '../packages/agent/src/ast.js';
import { wrapRouteHandler, wrapPagesHandler } from '../packages/node/src/next.js';
import { als } from '../packages/node/src/context.js';
import { HEADER } from '../packages/node/src/express.js';

const RUNTIME = pathToFileURL(path.resolve('packages/node/src/next.js')).href;
const FILE = path.resolve('/proj/app/api/items/route.ts');
const APP_INFO = { kind: 'app', path: '/api/items' };

// Every original line is still at the same number — minus its `export `
// keyword. (export { … } lines are rewritten in place; checked separately.)
function assertLinesKept(original, out) {
  const after = out.split('\n');
  original.split('\n').forEach((line, i) => {
    if (!/^export \{/.test(line)) assert.equal(after[i], line.replace(/^export (default )?/, ''), `line ${i + 1}`);
  });
}

// The { file, line, name } each wrapper is told, by exported name.
function metaOf(code) {
  const out = {};
  for (const m of code.matchAll(/const __feel_(\w+) = __feelWrap(?:Route|Pages)\([\w$]+, (\{.*\})\);/g)) {
    const { file, line, name } = JSON.parse(m[2]);
    out[m[1]] = { file, line, name };
  }
  return out;
}

const decode = (res) => JSON.parse(decodeURIComponent(res.headers.get(HEADER)));

// Load rewritten code as a real module (the runtime import points at the repo).
const load = (code) => import(`data:text/javascript,${encodeURIComponent(code)}`);

test('wrapRoute: every export form, lines kept, output parses as TypeScript', () => {
  const code = `import { other } from './other';
export async function GET(request: Request) {
  return Response.json({ ok: true });
}
export const POST = async () => new Response('x'), dynamic = 'force-dynamic';
async function handler() { return new Response('put'); }
export { handler as PUT, other };
export { DELETE } from './shared';
`;
  const out = wrapRoute(code, FILE, APP_INFO);
  parseCode(out.code, FILE); // throws if broken
  assertLinesKept(code, out.code);
  assert.match(out.code, /^async function GET/m);
  assert.match(out.code, /^const POST = async/m);
  assert.match(out.code, /export \{ other \};/);
  assert.match(out.code, /export \{ dynamic \};/);
  assert.match(out.code, /import \{ DELETE as __feel_src_DELETE \} from ".\/shared";/);
  for (const m of ['GET', 'POST', 'PUT', 'DELETE']) assert.match(out.code, new RegExp(`export \\{ __feel_${m} as ${m} \\};`));
  assert.match(out.code, /__feelWrapRoute\(handler, \{"file":.*"line":6,"name":"PUT","path":"\/api\/items"\}\)/);
  assert.equal(wrapRoute(out.code, FILE, APP_INFO), null, 'never wrapped twice');
  assert.equal(wrapRoute("module.exports = function () {};\n", FILE, APP_INFO), null, 'CommonJS left alone');
});

test('wrapped GET: runs in its request context, header carries route, handler and queries', async () => {
  const code = `import { als } from ${JSON.stringify(pathToFileURL(path.resolve('packages/node/src/context.js')).href)};

export async function GET(request) {
  als.getStore().queries.push({ sql: 'SELECT 1', tables: ['items'] });
  return Response.json({ ok: true });
}
`;
  const out = wrapRoute(code, FILE, APP_INFO, { runtime: RUNTIME });
  const mod = await load(out.code);
  assert.equal(mod.GET.name, 'GET');
  const res = await mod.GET(new Request('http://localhost/api/items'));
  const route = decode(res);
  assert.equal(route.method, 'GET');
  assert.equal(route.path, '/api/items');
  assert.deepEqual(route.handlers, [{ file: FILE, line: 3, name: 'GET', index: 0, direct: true }]);
  assert.deepEqual(route.queries, [{ sql: 'SELECT 1', tables: ['items'] }]);
  assert.equal(res.headers.get('Access-Control-Expose-Headers'), HEADER);
  assert.deepEqual(await res.json(), { ok: true });
});

test('wrapRouteHandler: immutable headers get a copy, other values pass through, errors propagate', async () => {
  const info = { file: FILE, line: 1, name: 'GET', path: '/api/items' };
  const redirect = await wrapRouteHandler(async () => Response.redirect('http://localhost/elsewhere', 302), info)(new Request('http://localhost/x'));
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'http://localhost/elsewhere');
  assert.equal(decode(redirect).path, '/api/items');

  const plain = { not: 'a response' };
  assert.equal(await wrapRouteHandler(async () => plain, info)(new Request('http://localhost/x')), plain);

  await assert.rejects(wrapRouteHandler(async () => { throw new Error('boom'); }, info)(new Request('http://localhost/x')), /boom/);

  // The app's own exposed headers are kept.
  const own = await wrapRouteHandler(async () => new Response('x', { headers: { 'Access-Control-Expose-Headers': 'X-Total' } }), info)(new Request('http://localhost/x'));
  assert.equal(own.headers.get('Access-Control-Expose-Headers'), `X-Total, ${HEADER}`);
});

test('header stays under budget with many long queries (headerValue)', async () => {
  const info = { file: FILE, line: 1, name: 'GET', path: '/api/items' };
  const res = await wrapRouteHandler(async () => {
    for (let i = 0; i < 200; i++) als.getStore().queries.push({ sql: `SELECT ${'x'.repeat(2000)}`, tables: [] });
    return new Response('ok');
  }, info)(new Request('http://localhost/x'));
  assert.ok(res.headers.get(HEADER).length <= 12 * 1024);
  assert.ok(decode(res).truncated > 0);
});

test('Pages Router: wrapRoute for export default, wrapPagesHandler sets the header at writeHead', async () => {
  const code = `export default function handler(req, res) {\n  res.end('ok');\n}\n`;
  const out = wrapRoute(code, FILE, { kind: 'pages', path: '/api/legacy' }, { runtime: RUNTIME });
  assert.match(out.code, /^function handler/);
  assert.match(out.code, /export \{ __feel_default as default \};/);
  const anon = wrapRoute('export default async (req, res) => res.end();\n', FILE, { kind: 'pages', path: '/api/legacy' });
  assert.match(anon.code, /^const __feel_default_handler = async/);

  const mod = await load(out.code);
  const headers = {};
  const res = {
    headersSent: false,
    setHeader: (k, v) => (headers[k] = v),
    writeHead() {},
    end() {
      this.writeHead(200);
    },
  };
  mod.default({ method: 'POST' }, res);
  const route = JSON.parse(decodeURIComponent(headers[HEADER]));
  assert.equal(route.method, 'POST');
  assert.equal(route.path, '/api/legacy');
  assert.equal(route.handlers[0].name, 'handler');

  assert.equal(typeof wrapPagesHandler(null, {}), 'object', 'non-functions pass through');
});

test('wrapRoute: destructured exports (Auth.js handlers) are wrapped, the rest re-exported', () => {
  const code = `import { handlers } from '@/auth';
export const { GET, POST, auth } = handlers;
export const runtime = 'nodejs';
`;
  const out = wrapRoute(code, FILE, APP_INFO);
  parseCode(out.code, FILE);
  assert.deepEqual(out.code.split('\n').slice(0, 3), [code.split('\n')[0], 'const { GET, POST, auth } = handlers;', "export const runtime = 'nodejs';"]);
  assert.match(out.code, /export \{ auth \};/);
  assert.deepEqual(metaOf(out.code), { GET: { file: FILE, line: 2, name: 'GET' }, POST: { file: FILE, line: 2, name: 'POST' } });
});

test('wrapRoute: a multi-line export { … } keeps every line below it in place', () => {
  const code = `function handler() {}
export {
  handler as GET,
  handler as POST,
};
function after() {}
`;
  const out = wrapRoute(code, FILE, APP_INFO);
  assert.equal(out.code.split('\n')[5], 'function after() {}', 'line 6 is still line 6');
  assert.deepEqual(metaOf(out.code).GET, { file: FILE, line: 1, name: 'GET' }, 'points at the function, not the export');
});

test('wrapRoute: a handler re-exported from another file points at that file (like the static scan)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feel-wrap-'));
  try {
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib', 'handlers.js'), '// shared\n\nexport async function sharedGet() {\n  return new Response("x");\n}\n');
    const route = path.join(dir, 'app', 'route.js');
    const out = wrapRoute("export { sharedGet as GET } from '../lib/handlers';\nexport { missing as POST } from '../lib/nowhere';\n", route, APP_INFO);
    const meta = metaOf(out.code);
    assert.deepEqual(meta.GET, { file: path.join(dir, 'lib', 'handlers.js'), line: 3, name: 'GET' });
    assert.deepEqual(meta.POST, { file: route, line: 2, name: 'POST' }, 'not found → the export line');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Pages Router: `export default handler;` at the bottom points at the function', () => {
  const code = `async function handler(req, res) {
  res.end('ok');
}

export default handler;
`;
  const out = wrapRoute(code, FILE, { kind: 'pages', path: '/api/legacy' });
  parseCode(out.code, FILE);
  assert.deepEqual(metaOf(out.code).default, { file: FILE, line: 1, name: 'handler' });
  const direct = wrapRoute('// top\n\nexport default function handler(req, res) {}\n', FILE, { kind: 'pages', path: '/api/legacy' });
  assert.equal(metaOf(direct.code).default.line, 3);
  const anon = wrapRoute('// top\nexport default async (req, res) => res.end();\n', FILE, { kind: 'pages', path: '/api/legacy' });
  assert.equal(metaOf(anon.code).default.line, 2);
});
