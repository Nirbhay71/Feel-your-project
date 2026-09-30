// The JSX tagging shared by the Vite plugin and the Next.js loader
// (@feel-dev/agent's transform.js), and what the Next loader does on top of
// it (@feel-dev/next's transform.js): tags go inside existing lines, so no
// line of the original file ever moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tagJsx } from '../packages/agent/src/transform.js';
import { parseCode } from '../packages/agent/src/ast.js';
import { transformForNext } from '../packages/next/src/transform.js';
import feel from '../packages/vite-plugin/src/index.js';

const ROOT = path.resolve('/proj');
const file = (rel) => path.join(ROOT, rel);

const LIST = `'use client';
import { useState } from 'react';

export default function ItemList({ items }) {
  const [open] = useState(true);
  return (
    <ul className="list">
      {items.map((i) => <li key={i.id}>{i.name}</li>)}
    </ul>
  );
}
`;

// Removes what tagJsx inserted: the attributes and the __feelSrc footer.
const untag = (code) => code.replace(/ data-src="[^"]*"/g, '').replace(/\n;\[\[.*\]\]\.forEach\([^\n]*\n$/, '');

test('tagJsx: data-src on DOM tags, __feelSrc footer, every original line intact', () => {
  const out = tagJsx(LIST, file('components/ItemList.jsx'), { root: ROOT });
  assert.match(out.code, /<ul data-src="components\/ItemList\.jsx:7:5\|ItemList" className="list">/);
  assert.match(out.code, /<li data-src="components\/ItemList\.jsx:8:25\|ItemList" key=/);
  assert.match(out.code, /\[ItemList, "components\/ItemList\.jsx:4\|ItemList"\]/);
  assert.equal(untag(out.code), LIST);
  const lines = out.code.split('\n');
  assert.equal(lines[0], "'use client';", "'use client' stays the first statement");
  assert.equal(out.map.sources[0], file('components/ItemList.jsx'));
});

test('Vite plugin and Next loader tag .jsx / .tsx files identically', () => {
  const vite = feel();
  vite.configResolved({ root: ROOT, resolve: { alias: [] } });
  for (const rel of ['components/ItemList.jsx', 'components/ItemList.tsx']) {
    const a = vite.transform(LIST, `${file(rel)}?v=1`);
    const b = transformForNext(LIST, file(rel), { root: ROOT, server: false });
    assert.equal(a.code, b.code, rel);
  }
});

test('Next loader: .js with JSX is tagged, .js without JSX and .ts are left alone', () => {
  assert.match(transformForNext(LIST, file('app/page.js'), { root: ROOT }).code, /data-src="app\/page\.js:7:5\|ItemList"/);

  // A capitalised class in a plain module isn't a component.
  const plain = 'export class Store { get(x) { return x < 3; } }\n';
  assert.equal(transformForNext(plain, file('lib/store.js'), { root: ROOT }), null);

  // .ts is never JSX, even with a "<" in it (old-style cast).
  const ts = 'export const n = <number>(1 as unknown);\nexport function Big() { return n; }\n';
  assert.equal(transformForNext(ts, file('lib/n.ts'), { root: ROOT }), null);
  assert.equal(parseCode(ts, 'n.ts').program.body.length, 2, 'parseCode reads .ts casts');
});

test('Next loader: syntax errors and node_modules pass through; files beside the app are tagged like Vite does', () => {
  assert.equal(transformForNext('export default () => <div', file('app/page.jsx'), { root: ROOT }), null);
  assert.equal(transformForNext(LIST, path.join(ROOT, 'node_modules', 'x', 'a.jsx'), { root: ROOT }), null);
  assert.match(transformForNext(LIST, path.resolve('/shared/a.jsx'), { root: ROOT }).code, /data-src="\.\.\/shared\/a\.jsx:7:5\|ItemList"/);
});

test('Next loader: JSX-free route.ts and route.js are wrapped (server build only)', () => {
  const routeTs = `import { pool } from '../../../lib/db';

export async function GET(request: Request) {
  return Response.json(await pool.query('SELECT 1'));
}
`;
  const ts = transformForNext(routeTs, file('app/api/items/route.ts'), { root: ROOT, server: true });
  assert.ok(ts, 'route.ts wrapped');
  assert.match(ts.code, /__feelWrapRoute\(GET, \{.*"path":"\/api\/items"/);
  assert.ok(ts.map, 'a map comes along');
  assert.equal(transformForNext(routeTs, file('app/api/items/route.ts'), { root: ROOT, server: false }), null, 'browser build untouched');

  const routeJs = 'export async function POST() {\n  return new Response(null);\n}\n';
  const js = transformForNext(routeJs, file('app/api/x/[id]/route.js'), { root: ROOT, server: true });
  assert.match(js.code, /__feelWrapRoute\(POST, \{.*"path":"\/api\/x\/:id"/);
  assert.deepEqual(js.code.split('\n').slice(0, 3), ['async function POST() {', '  return new Response(null);', '}']);
});
