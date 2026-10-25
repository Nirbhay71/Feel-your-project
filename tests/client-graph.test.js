import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../packages/client/src/graph.js';

const entry = { component: 'Users', file: 'Users.jsx', line: 1 };
const graph = (req, tableInfo = new Map()) => buildGraph({ entry, requests: [{ req, frames: [] }], tableInfo });

test('Supabase reads and writes connect the component to a clickable table', () => {
  for (const operation of ['select', 'insert', 'update', 'delete']) {
    const { nodes, edges } = graph({ url: 'https://project.supabase.co/rest/v1/users', status: 200, supabase: { operation, table: 'users' } });
    const route = [...nodes.values()].find((n) => n.kind === 'route');
    assert.equal(route.label, `Supabase ${operation}`);
    assert.deepEqual(nodes.get('table:users').action, { table: 'users' });
    assert.equal(!!nodes.get('table:users').write, operation !== 'select');
    assert.equal(edges.size, 2);
  }
});

test('requests without backend instrumentation remain visible in the graph', () => {
  const { nodes, edges } = graph({ method: 'GET', url: '/api/users', status: 503, duration: 12, backend: null });
  const route = [...nodes.values()].find((n) => n.kind === 'route');
  assert.equal(route.label, 'GET /api/users');
  assert.equal(route.error, true);
  assert.equal(edges.size, 1);
});

test('Supabase tables get related tables when metadata becomes available', () => {
  const tableInfo = new Map([['users', { rowCount: 2, references: [{ to_table: 'teams' }], referencedBy: [] }]]);
  const { nodes } = graph({ url: 'https://project.supabase.co/rest/v1/users', status: 200, supabase: { operation: 'select', table: 'users' } }, tableInfo);
  assert.equal(nodes.get('table:users').sub, '2 rows');
  assert.equal(nodes.get('table:teams').kind, 'related');
});
