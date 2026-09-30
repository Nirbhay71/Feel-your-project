// The agent route under Next.js (@feel-dev/next's agent.js): the gates in
// front of the agent — development only, this machine only (by TCP peer and
// by Host), same origin, X-Feel on POSTs — and "Open in editor" through
// Next's own endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFeelRoute, hostAllowed } from '../packages/next/src/agent.js';
import { runAsPeer, isLoopback, trackPeers, currentPeer } from '../packages/next/src/peer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, 'fixtures', 'next-app');

// The agent only ever loads under `next dev`, which runs with this.
process.env.NODE_ENV = 'development';

const LOCAL = { address: '127.0.0.1', localAddress: '127.0.0.1', localPort: 3000, secure: false };

// Calls the route the way Next does: a Request plus { params: Promise },
// while a request from `peer` (by default this machine) is being handled.
async function call(route, url, { method = 'GET', headers = {}, body, peer = LOCAL } = {}) {
  const u = new URL(url);
  const segments = u.pathname.replace(/^\/__feel\//, '').split('/');
  const request = new Request(url, { method, headers: { host: u.host, ...headers }, body });
  const run = () => route[method](request, { params: Promise.resolve({ path: segments }) });
  const res = await (peer ? runAsPeer(peer, run) : run());
  return { status: res.status, body: await res.json() };
}

const SOURCE = 'http://localhost:3000/__feel/source?file=app/api/items/route.ts&line=11';
const dev = (more) => createFeelRoute({ dev: true, root: APP, projectRoot: APP, ...more });

test('dev: /source answers, and Open in editor goes through /__nextjs_launch-editor (both parameter styles)', async () => {
  const { status, body } = await call(dev(), SOURCE);
  assert.equal(status, 200);
  assert.equal(body.name, 'GET');
  const file = encodeURIComponent(path.join(APP, 'app', 'api', 'items', 'route.ts'));
  assert.equal(body.openUrl, `/__nextjs_launch-editor?file=${file}&line1=11&column1=1&lineNumber=11&column=1`);
  assert.equal((await call(dev(), 'http://localhost:3000/__feel/nope')).status, 404);
  assert.match((await call(dev({ basePath: '/docs' }), SOURCE)).body.openUrl, /^\/docs\/__nextjs_launch-editor\?/, 'under the basePath');
});

test('cross-origin requests and POSTs without X-Feel are refused', async () => {
  const route = dev();
  assert.equal((await call(route, SOURCE, { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await call(route, 'http://localhost:3000/__feel/stack', { method: 'POST', body: '{}' })).status, 403);
  const ok = await call(route, 'http://localhost:3000/__feel/stack', { method: 'POST', body: '{"stack":""}', headers: { 'x-feel': '1' } });
  assert.deepEqual(ok, { status: 200, body: { frames: [] } });
});

test('DNS rebinding: a Host that is not this machine is refused, unless allowed', async () => {
  const evil = await call(dev(), SOURCE.replace('localhost:3000', 'evil.example:3000'), { headers: { origin: 'http://evil.example:3000' } });
  assert.equal(evil.status, 403);
  assert.equal((await call(dev(), SOURCE.replace('localhost', '127.0.0.1'))).status, 200);

  const allowed = dev({ allowedHosts: ['*.my-dev.test'] });
  assert.equal((await call(allowed, SOURCE.replace('localhost', 'box.my-dev.test'))).status, 200);
  assert.equal((await call(allowed, SOURCE.replace('localhost', 'evilmy-dev.test'))).status, 403, '*.x is a subdomain, not a suffix');

  assert.equal(hostAllowed('localhost:3000'), true);
  assert.equal(hostAllowed('app.localhost'), true);
  assert.equal(hostAllowed('[::1]:3000'), true);
  assert.equal(hostAllowed('127.0.0.1.evil.example'), false);
  assert.equal(hostAllowed('localhost.evil.example'), false);
  assert.equal(hostAllowed(''), false);
  assert.equal(hostAllowed('192.168.1.5:3000', ['192.168.1.5']), true);
  assert.equal(hostAllowed('evilx:3000', ['*.x']), false);
});

test('LAN: another machine is refused whatever Host or X-Forwarded-For it sends, unless its address is allowed', async () => {
  const lan = { address: '192.168.1.20', localAddress: '192.168.1.5', localPort: 3000, secure: false };
  const spoofed = await call(dev(), SOURCE, { peer: lan, headers: { 'x-forwarded-for': '127.0.0.1' } });
  assert.equal(spoofed.status, 403);
  assert.match(spoofed.body.error, /192\.168\.1\.20/);
  assert.equal((await call(dev({ allowedAddresses: ['192.168.1.20'] }), SOURCE, { peer: lan })).status, 200);
  assert.equal((await call(dev(), SOURCE, { peer: { ...lan, address: '::ffff:127.0.0.1' } })).status, 200, 'IPv4 loopback on an IPv6 socket');
  assert.equal((await call(dev(), SOURCE, { peer: null })).status, 403, 'peer unknown (withFeel not loaded) → refused');

  assert.deepEqual(['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'].map(isLoopback), [true, true, true, true]);
  assert.deepEqual(['192.168.1.5', '::ffff:10.0.0.1', '::2', '', undefined, '127.0.0.1.x'].map(isLoopback), [false, false, false, false, false, false]);
});

test('trackPeers: a real HTTP server sees the TCP peer inside its async request handling', async () => {
  trackPeers();
  const server = http.createServer(async (req, res) => {
    await new Promise((r) => setTimeout(r, 5)); // Next awaits a lot before the route handler runs
    res.end(JSON.stringify(currentPeer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    const seen = await (await fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-forwarded-for': '10.0.0.1' } })).json();
    assert.equal(seen.address, '127.0.0.1');
    assert.equal(seen.localPort, port);
    assert.equal(currentPeer(), null, 'outside a request: nothing');
  } finally {
    server.close();
  }
});

test('maps are fetched from the port the request came in on, never the Host header’s', async () => {
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response('', { status: 404 });
  };
  try {
    const stack = 'Error\n    at x (http://localhost:4555/_next/static/chunks/app.js:1:1)';
    const res = await call(dev(), 'http://localhost:4555/__feel/stack', { method: 'POST', body: JSON.stringify({ stack }), headers: { 'x-feel': '1' } });
    assert.equal(res.status, 200);
    assert.deepEqual(fetched, ['http://127.0.0.1:3000/_next/static/chunks/app.js.map']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an agent that failed to start is tried again on the next request', async () => {
  const route = dev();
  process.env.NODE_ENV = 'test';
  assert.equal((await call(route, SOURCE)).status, 500);
  process.env.NODE_ENV = 'development';
  assert.equal((await call(route, SOURCE)).status, 200);
});

test('production: 404 unless withFeel set up next dev', async () => {
  const saved = { env: process.env.NODE_ENV, feel: process.env.__FEEL_NEXT };
  const app = { root: APP, projectRoot: APP }; // enough for a 200 once the gates open
  try {
    assert.equal((await call(createFeelRoute({ ...app, dev: false }), SOURCE)).status, 404);

    process.env.NODE_ENV = 'development';
    delete process.env.__FEEL_NEXT;
    assert.equal((await call(createFeelRoute(app), SOURCE)).status, 404, 'no withFeel → nothing');

    process.env.NODE_ENV = 'production';
    process.env.__FEEL_NEXT = JSON.stringify(app);
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
