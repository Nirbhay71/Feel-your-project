// Import resolution: relative, Vite aliases, tsconfig/jsconfig paths, baseUrl,
// Node package.json "imports" — and packages must stay unresolved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveImport, setViteAliases } from '../packages/agent/src/resolve.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'aliases');
const from = (file, spec) => {
  const r = resolveImport(path.join(FIX, file), spec);
  return r && path.relative(FIX, r).split(path.sep).join('/');
};

test('relative imports, with and without extension', () => {
  assert.equal(from('vite-ts/src/App.tsx', './components/Card'), 'vite-ts/src/components/Card.tsx');
  assert.equal(from('vite-ts/src/App.tsx', './lib/api.ts'), 'vite-ts/src/lib/api.ts');
});

test('tsconfig paths found through project references + extends (Vite TS template)', () => {
  assert.equal(from('vite-ts/src/App.tsx', '@/components/Card'), 'vite-ts/src/components/Card.tsx');
});

test('tsconfig paths: the longest matching prefix wins', () => {
  assert.equal(from('vite-ts/src/App.tsx', '@lib/api'), 'vite-ts/src/lib/api.ts');
});

test('jsconfig baseUrl alone resolves bare paths', () => {
  assert.equal(from('base/src/App.jsx', 'components/Card'), 'base/src/components/Card.jsx');
});

test('package.json "imports": exact and pattern with conditions', () => {
  assert.equal(from('node/index.js', '#db'), 'node/lib/db.js');
  assert.equal(from('node/index.js', '#lib/util'), 'node/lib/util.js'); // "node" condition wins
});

test('packages are never followed — and "@" does not swallow "@scope/pkg"', () => {
  assert.equal(from('vite-ts/src/App.tsx', 'react'), null);
  assert.equal(from('vite-ts/src/App.tsx', '@tanstack/react-query'), null);
});

test('Vite aliases: string and RegExp, absolute and root-relative', () => {
  setViteAliases(
    [
      { find: '~', replacement: path.join(FIX, 'vite-ts/src') },
      { find: /^@@\/(.*)$/, replacement: '/src/$1' },
    ],
    path.join(FIX, 'vite-ts'),
  );
  try {
    assert.equal(from('node/index.js', '~/lib/api'), 'vite-ts/src/lib/api.ts');
    assert.equal(from('node/index.js', '@@/components/Card'), 'vite-ts/src/components/Card.tsx');
  } finally {
    setViteAliases([], process.cwd());
  }
});
