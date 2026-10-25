import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { possibleCalls } from '../packages/agent/src/static.js';
import { reachableFunctions } from '../packages/agent/src/graph.js';

const root = fileURLToPath(new URL('./fixtures/context-app/', import.meta.url));
const abs = path.join(root, 'Login.jsx');
const display = (file) => path.relative(root, file).split(path.sep).join('/');

test('renamed context hooks and callbacks resolve only the selected provider function', async () => {
  const calls = await possibleCalls({ abs, component: 'Login', rootDir: root, display });
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [['POST', '/api/login']]);
  assert.ok(calls[0].chain.some((c) => c.fn === 'login'));
  const reach = await reachableFunctions(abs, 'Login', display);
  assert.ok(reach.functions.includes('Auth.jsx#login'));
  assert.ok(reach.direct.includes('Auth.jsx#AuthProvider'));
  assert.ok(!reach.functions.includes('Auth.jsx#profile'));
});

test('ordinary hook return objects are not mistaken for context callbacks', async () => {
  const reach = await reachableFunctions(abs, 'Other', display);
  assert.ok(!reach.functions.includes('Auth.jsx#login'));
  assert.ok(!reach.functions.includes('Auth.jsx#AuthProvider'));
});

test('multiple providers do not guess which callback belongs to the consumer', async () => {
  const reach = await reachableFunctions(path.join(root, 'Ambiguous.jsx'), 'Consumer', display);
  assert.ok(!reach.functions.includes('Ambiguous.jsx#login'));
  assert.ok(!reach.functions.includes('Ambiguous.jsx#First'));
  assert.ok(!reach.functions.includes('Ambiguous.jsx#Second'));
});

test('reassigned callbacks do not retain a context provider attribution', async () => {
  const reach = await reachableFunctions(abs, 'Reassigned', display);
  assert.ok(!reach.functions.includes('Auth.jsx#login'));
  assert.ok(!reach.functions.includes('Auth.jsx#AuthProvider'));
});
