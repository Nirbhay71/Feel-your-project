import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentJson } from '../packages/client/src/agent-request.js';

test('agent requests time out even when the transport ignores abort', async (t) => {
  let signal;
  t.mock.method(globalThis, 'fetch', (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  await assert.rejects(agentJson('/__feel/reach', { timeout: 10 }), /timed out/);
  assert.equal(signal.aborted, true);
});

test('HTTP and invalid JSON failures remain errors instead of empty analysis', async (t) => {
  const transport = t.mock.method(globalThis, 'fetch', async () => new Response('Unavailable', { status: 503 }));
  await assert.rejects(agentJson('/__feel/reach'), /503/);
  transport.mock.mockImplementation(async () => new Response('not json'));
  await assert.rejects(agentJson('/__feel/reach'), SyntaxError);
});

test('successful agent requests return parsed data', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ calls: [] }));
  assert.deepEqual(await agentJson('/__feel/possible'), { calls: [] });
});
