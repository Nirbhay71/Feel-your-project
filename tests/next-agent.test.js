// The agent route under Next.js (@feel-dev/next's agent.js): the gates in
// front of the agent — development only, this machine only, same origin,
// X-Feel on POSTs — and "Open in editor" through Next's own endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFeelRoute, hostAllowed } from '../packages/next/src/agent.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, 'fixtures', 'next-app');

// Calls the route the way Next does: a Request plus { params: Promise }.
async function call(route, url, { method = 'GET', headers = {}, body } = {}) {
  const u = new URL(url);
  const segments = u.pathname.replace(/^\/__feel\//, '').split('/');
  const request = new Request(url, { method, headers: { host: u.host, ...headers }, body });
  const res = await route[method](request, { params: Promise.resolve({ path: segments }) });
  return { status: res.status, body: await res.json() };
}

const SOURCE = 'http://localhost:3000/__feel/source?file=app/api/items/route.ts&line=11';

test('dev: /source answers, and Open in editor goes through /__nextjs_launch-editor', async () => {
  const route = createFeelRoute({ dev: true, root: APP, projectRoot: APP });
  const { status, body } = await call(route, SOURCE);
  assert.equal(status, 200);
  assert.equal(body.name, 'GET');
  assert.equal(body.openUrl, `/__nextjs_launch-editor?file=${encodeURIComponent(path.join(APP, 'app', 'api', 'items', 'route.ts'))}&line1=11&column1=1`);
  assert.equal((await call(route, 'http://localhost:3000/__feel/nope')).status, 404);
});

test('cross-origin requests and POSTs without X-Feel are refused', async () => {
  const route = createFeelRoute({ dev: true, root: APP, projectRoot: APP });
  assert.equal((await call(route, SOURCE, { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await call(route, 'http://localhost:3000/__feel/stack', { method: 'POST', body: '{}' })).status, 403);
  const ok = await call(route, 'http://localhost:3000/__feel/stack', { method: 'POST', body: '{"stack":""}', headers: { 'x-feel': '1' } });
  assert.deepEqual(ok, { status: 200, body: { frames: [] } });
});

test('DNS rebinding: a Host that is not this machine is refused, unless allowed', async () => {
  const route = createFeelRoute({ dev: true, root: APP, projectRoot: APP });
  const evil = await call(route, SOURCE.replace('localhost:3000', 'evil.example:3000'), { headers: { origin: 'http://evil.example:3000' } });
  assert.equal(evil.status, 403);
  assert.equal((await call(route, SOURCE.replace('localhost', '127.0.0.1'))).status, 200);

  const allowed = createFeelRoute({ dev: true, root: APP, projectRoot: APP, allowedHosts: ['*.my-dev.test'] });
  assert.equal((await call(allowed, SOURCE.replace('localhost', 'box.my-dev.test'))).status, 200);

  assert.equal(hostAllowed('localhost:3000'), true);
  assert.equal(hostAllowed('app.localhost'), true);
  assert.equal(hostAllowed('[::1]:3000'), true);
  assert.equal(hostAllowed('127.0.0.1.evil.example'), false);
  assert.equal(hostAllowed('localhost.evil.example'), false);
  assert.equal(hostAllowed(''), false);
  assert.equal(hostAllowed('192.168.1.5:3000', ['192.168.1.5']), true);
});

test('production: 404 unless withFeel set up next dev', async () => {
  const saved = { env: process.env.NODE_ENV, feel: process.env.__FEEL_NEXT };
  try {
    assert.equal((await call(createFeelRoute({ dev: false, root: APP }), SOURCE)).status, 404);

    process.env.NODE_ENV = 'development';
    delete process.env.__FEEL_NEXT;
    assert.equal((await call(createFeelRoute(), SOURCE)).status, 404, 'no withFeel → nothing');

    process.env.NODE_ENV = 'production';
    process.env.__FEEL_NEXT = JSON.stringify({ root: APP, projectRoot: APP });
    assert.equal((await call(createFeelRoute(), SOURCE)).status, 404, 'next start → nothing');

    process.env.NODE_ENV = 'development';
    assert.equal((await call(createFeelRoute(), SOURCE)).status, 200, 'next dev with withFeel → the agent');
  } finally {
    if (saved.env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.env;
    if (saved.feel === undefined) delete process.env.__FEEL_NEXT;
    else process.env.__FEEL_NEXT = saved.feel;
  }
});
