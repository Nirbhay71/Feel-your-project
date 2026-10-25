import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import feel from '../packages/vite-plugin/src/index.js';

test('workspace Vite stacks exclude Feel internals served through Linux /@fs URLs', async () => {
  const root = fileURLToPath(new URL('./fixtures/browser-app/', import.meta.url));
  const network = fileURLToPath(new URL('../packages/client/src/network.js', import.meta.url));
  const app = fileURLToPath(new URL('./fixtures/browser-app/src/main.jsx', import.meta.url));
  const internalURL = '/@fs/home/runner/work/Feel-your-project/Feel-your-project/packages/client/src/network.js';
  const plugin = feel({ projectRoot: root });
  plugin.configResolved({ root, resolve: { alias: [] } });
  let middleware;
  plugin.configureServer({
    moduleGraph: { getModuleByUrl: async (url) => ({ file: url === internalURL ? network : app }) },
    middlewares: { use: (route, handler) => { middleware = handler; } },
  });
  const stack = `Error
    at captureStack (http://localhost:5173${internalURL}:104:17)
    at window.fetch (http://localhost:5173${internalURL}:135:17)
    at App (http://localhost:5173/src/main.jsx:7:5)`;
  const request = Object.assign(Readable.from([JSON.stringify({ stack })]), {
    method: 'POST', url: '/stack', headers: { host: 'localhost:5173', 'x-feel': '1' },
  });
  let body;
  const response = { setHeader() {}, end: (value) => { body = JSON.parse(value); } };
  await middleware(request, response, () => assert.fail('Stack route was not handled'));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.frames.map((f) => [f.file, f.component]), [['src/main.jsx', 'App']]);
});
