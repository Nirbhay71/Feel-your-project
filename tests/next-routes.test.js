// Next.js file-system routes in the static "possible calls": folder names →
// Express-shaped paths (next-routes.js), and the fixture app
// tests/fixtures/next-app end to end through possibleCalls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextRouteInfo, nextRoutesIn, findNextRoot } from '../packages/agent/src/next-routes.js';
import { possibleCalls } from '../packages/agent/src/static.js';
import { loadFile } from '../packages/agent/src/files.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, 'fixtures', 'next-app');

test('nextRouteInfo: folder names → route paths', () => {
  const cases = {
    'app/route.js': '/',
    'app/api/items/route.ts': '/api/items',
    'src/app/api/items/route.tsx': '/api/items',
    'app/api/items/[id]/route.ts': '/api/items/:id',
    'app/(admin)/api/stats/route.js': '/api/stats',
    'app/api/files/[...path]/route.js': '/api/files/*',
    'app/api/docs/[[...slug]]/route.js': '/api/docs/*',
    'app/api/%5Fx/route.js': '/api/_x',
    'pages/api/legacy.js': '/api/legacy',
    'pages/api/users/index.ts': '/api/users',
    'pages/api/users/[id].ts': '/api/users/:id',
    'app/_private/route.js': null,
    'app/@modal/api/route.js': null,
    'app/%5F%5Ffeel/[...path]/route.js': null, // Feel's own agent route
    'app/api/items/page.js': null,
    'pages/about.js': null,
  };
  for (const [rel, expected] of Object.entries(cases)) assert.equal(nextRouteInfo(rel)?.path ?? null, expected, rel);
  assert.equal(nextRouteInfo('app/api/items/route.ts').kind, 'app');
  assert.equal(nextRouteInfo('pages/api/legacy.js').kind, 'pages');
  assert.equal(nextRouteInfo('app/api/docs/[[...slug]]/route.js').optionalCatchAll, true);
});

test('findNextRoot: the folder with next.config.* above app/ or pages/', () => {
  const repo = path.join(HERE, '..');
  assert.equal(findNextRoot(path.join(APP, 'app', 'api', 'items', 'route.ts'), repo), APP);
  assert.equal(findNextRoot(path.join(APP, 'pages', 'api', 'legacy.js'), repo), APP);
  assert.equal(findNextRoot(path.join(repo, 'demo', 'server', 'app.js'), repo), null);
});

// Every route the fixture defines, as "METHOD path → file:line (name)".
test('nextRoutesIn: the fixture app', async () => {
  const files = [
    'app/api/items/route.ts',
    'app/api/items/[id]/route.ts',
    'app/(admin)/api/stats/route.js',
    'pages/api/legacy.js',
  ];
  const seen = [];
  for (const rel of files) {
    const abs = path.join(APP, rel);
    const { ast } = await loadFile(abs);
    for (const r of await nextRoutesIn(abs, ast, nextRouteInfo(rel))) {
      assert.ok(r.direct);
      seen.push(`${r.method} ${r.fullPath} → ${path.relative(APP, r.handlerTarget.file).split(path.sep).join('/')}:${r.handlerTarget.line}`);
    }
  }
  assert.deepEqual(seen, [
    'GET /api/items → app/api/items/route.ts:11',
    'POST /api/items/:id → app/api/items/[id]/route.ts:6',
    'GET /api/stats → app/(admin)/api/stats/route.js:2',
    'ALL /api/legacy → pages/api/legacy.js:2',
  ]);
});

test('nextRoutesIn: other export forms, re-exports and optional catch-all', async () => {
  const { parseCode } = await import('../packages/agent/src/ast.js');
  const code = `async function handler() {}
export const PUT = async () => {};
export { handler as DELETE };
export const dynamic = 'force-dynamic';
`;
  const file = path.join(APP, 'app', 'api', 'docs', '[[...slug]]', 'route.js');
  const routes = await nextRoutesIn(file, parseCode(code, file), nextRouteInfo('app/api/docs/[[...slug]]/route.js'));
  assert.deepEqual(
    routes.map((r) => `${r.method} ${r.fullPath}:${r.line}`),
    ['PUT /api/docs/*:2', 'PUT /api/docs:2', 'DELETE /api/docs/*:1', 'DELETE /api/docs:1'],
  );
});

test('nextRoutesIn: destructured exports and re-exports from another file', async () => {
  const { parseCode } = await import('../packages/agent/src/ast.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feel-next-routes-'));
  try {
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib', 'handlers.js'), '// shared\n\nexport async function sharedGet() {}\n');
    const file = path.join(dir, 'app', 'api', 'shared', 'route.js');
    const code = "import { handlers } from '../../../lib/auth';\nexport const { POST, PUT: put, ...rest } = handlers;\nexport { sharedGet as GET } from '../../../lib/handlers';\n";
    const routes = await nextRoutesIn(file, parseCode(code, file), nextRouteInfo('app/api/shared/route.js'));
    const rel = (f) => path.relative(dir, f).split(path.sep).join('/');
    assert.deepEqual(
      routes.map((r) => `${r.method} at ${rel(r.file)}:${r.line} → ${rel(r.handlerTarget.file)}:${r.handlerTarget.line}`),
      ['POST at app/api/shared/route.js:2 → app/api/shared/route.js:2', 'GET at app/api/shared/route.js:3 → lib/handlers.js:3'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('possibleCalls: ItemList → Next route handlers, their SQL and tables', async () => {
  const display = (abs) => path.relative(APP, abs).split(path.sep).join('/');
  const calls = await possibleCalls({ abs: path.join(APP, 'components', 'ItemList.jsx'), component: 'ItemList', rootDir: APP, display });
  const summary = calls
    .map((c) => ({
      call: `${c.method} ${c.url}`,
      route: c.route && `${c.route.method} ${c.route.path}`,
      handler: c.route && `${display(c.route.handler.file)}:${c.route.handler.line} ${c.route.handler.name}`,
      direct: c.route?.handler.direct,
      tables: c.route?.queries.flatMap((q) => q.tables.map((t) => `${t.name}${t.access === 'write' ? '✎' : ''}`)).sort() ?? [],
    }))
    .sort((a, b) => a.call.localeCompare(b.call));
  assert.deepEqual(summary, [
    { call: 'GET /api/items', route: 'GET /api/items', handler: 'app/api/items/route.ts:11 GET', direct: true, tables: ['items'] },
    { call: 'POST /api/items/*', route: 'POST /api/items/:id', handler: 'app/api/items/[id]/route.ts:6 POST', direct: true, tables: ['items✎'] },
  ]);
});
