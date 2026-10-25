import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { diagnose } from '../packages/agent/src/diagnostics.js';
import { createAgentHandler } from '../packages/agent/src/index.js';
import { runtimeChecks } from '../packages/client/src/diagnostics.js';

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feel-diagnostics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@prisma/client': '^5.22.0', react: '^19', vite: '^7' } }));
  const installed = path.join(root, 'node_modules', '@prisma', 'client');
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: '@prisma/client', version: '5.22.0' }));
  return root;
}

test('diagnostics explain optional database and unsupported Prisma capture', async (t) => {
  const root = project(t);
  const result = await diagnose({ root, projectRoot: root, configured: false });
  assert.equal(result.checks.find((c) => c.id === 'database').status, 'optional');
  assert.equal(result.checks.find((c) => c.id === 'prisma').status, 'warning');
});

test('database health distinguishes success from failure without exposing errors', async (t) => {
  const root = project(t);
  const good = await diagnose({ root, projectRoot: root, configured: true, probe: async () => {} });
  assert.equal(good.checks.find((c) => c.id === 'database').status, 'ok');
  const bad = await diagnose({ root, projectRoot: root, configured: true, probe: async () => { throw new Error('postgres://secret:password@private-host'); } });
  assert.equal(bad.checks.find((c) => c.id === 'database').status, 'error');
  assert.ok(!JSON.stringify(bad).includes('secret'));
});

test('runtime checks use observed metadata and do not claim unseen SQL is disconnected', () => {
  assert.equal(runtimeChecks([])[0].status, 'unknown');
  assert.equal(runtimeChecks([{ url: '/api/users', status: 200 }])[0].status, 'warning');
  assert.equal(runtimeChecks([{ url: '/api/users', status: 200, backend: { queries: [{ sql: 'SELECT 1' }] } }])[1].status, 'ok');
  assert.equal(runtimeChecks([{ url: 'https://p.supabase.co/rest/v1/users', status: 200, supabase: {} }])[0].status, 'unknown');
});

test('diagnostics use the existing origin gates', async (t) => {
  const root = project(t);
  const agent = createAgentHandler({ root, projectRoot: root });
  const request = { method: 'GET', pathname: '/diagnostics', searchParams: new URLSearchParams(), headers: { host: 'localhost:5173' } };
  assert.equal((await agent.handle(request)).status, 200);
  assert.equal((await agent.handle({ ...request, headers: { ...request.headers, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await agent.handle({ ...request, headers: { ...request.headers, 'sec-fetch-site': 'cross-site' } })).status, 403);
});
