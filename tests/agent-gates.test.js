// The agent's own gates, shared by Vite and Next.js (@feel-dev/agent's
// createAgentHandler): which files /source may read, and which requests are
// refused before any route runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentHandler } from '../packages/agent/src/index.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'feel-gates-'));
const FILES = ['src/App.jsx', 'dist/assets/index.js', '.next/server/app/page.js', 'build/main.js', 'coverage/lcov-report/x.js', '.vite/deps/react.js', '.svelte-kit/output/a.js', '.turbo/x.js', 'src/build-info.js'];
for (const rel of FILES) {
  fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, rel), 'export function f() {\n  return 1;\n}\n');
}

const agent = createAgentHandler({ root: ROOT, projectRoot: ROOT });
const get = (file, headers = {}) =>
  agent.handle({
    method: 'GET',
    pathname: '/source',
    searchParams: new URLSearchParams({ file, line: '2' }),
    headers: { host: 'localhost:5173', ...headers },
    readBody: async () => '',
    origin: 'http://localhost:5173',
  });

test('/source never reads build output (.next, dist, build, coverage, …)', async () => {
  assert.equal((await get('src/App.jsx')).status, 200);
  assert.equal((await get('src/build-info.js')).status, 200, 'only whole folder names count');
  for (const rel of FILES.filter((f) => !f.startsWith('src/'))) assert.equal((await get(rel)).status, 403, rel);
});

test('a cross-site request is refused even without an Origin header', async () => {
  assert.equal((await get('src/App.jsx', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await get('src/App.jsx', { 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await get('src/App.jsx', { 'sec-fetch-site': 'none' })).status, 200, 'typed into the address bar');
});

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
