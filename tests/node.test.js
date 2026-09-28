// @feel-dev/node against a real Express server: the X-Feel-Route header must name
// the route, the handler's registration file:line and a unique request id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { instrumentExpress } from '../packages/node/src/index.js';

instrumentExpress(express); // before any routes are defined

const app = express();
const router = express.Router();
router.get('/', (req, res) => res.json({ ok: true })); // REGISTERED_HERE
router.get('/:id', function getThing(req, res) {
  res.status(404).json({ error: 'nope' });
});
app.use('/api/things', router);

const THIS_FILE = fileURLToPath(import.meta.url);
const REGISTERED_LINE = fs.readFileSync(THIS_FILE, 'utf8').split('\n').findIndex((l) => l.includes('// REGISTERED_HERE')) + 1;

async function withServer(fn) {
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

const route = (res) => JSON.parse(decodeURIComponent(res.headers.get('x-feel-route')));

test('route header names the route, handler registration and a request id', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/things`);
    const info = route(res);
    assert.equal(info.method, 'GET');
    assert.equal(info.path, '/api/things'); // mount "/api/things" + "/" → no trailing slash
    assert.equal(info.handlers.length, 1);
    assert.equal(info.handlers[0].file, THIS_FILE);
    assert.equal(info.handlers[0].line, REGISTERED_LINE);
    assert.match(info.id, /^[0-9a-f-]{36}$/);
    assert.equal(res.headers.get('access-control-expose-headers'), 'X-Feel-Route');
  });
});

test('error responses still carry the route, with the handler name', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/things/42`);
    assert.equal(res.status, 404);
    const info = route(res);
    assert.equal(info.path, '/api/things/:id');
    assert.equal(info.handlers[0].name, 'getThing');
  });
});

test('every request gets its own id', async () => {
  await withServer(async (base) => {
    const [a, b] = await Promise.all([fetch(`${base}/api/things`), fetch(`${base}/api/things`)]);
    assert.notEqual(route(a).id, route(b).id);
  });
});
