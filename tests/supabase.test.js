import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSupabaseRequest } from '../packages/client/src/supabase.js';

test('parses Supabase table URLs, selected columns, and filters', () => {
  assert.deepEqual(
    parseSupabaseRequest(
      'https://project.supabase.co/rest/v1/users?select=id%2Cname&name=eq.Ada&age=gt.18',
      'GET',
    ),
    {
      table: 'users',
      columns: ['id', 'name'],
      filters: [
        { name: 'name', value: 'eq.Ada' },
        { name: 'age', value: 'gt.18' },
      ],
      operation: 'select',
    },
  );
});

test('maps supported HTTP methods to Supabase operations', () => {
  assert.deepEqual(
    ['GET', 'POST', 'PATCH', 'DELETE'].map((method) => parseSupabaseRequest('https://project.supabase.co/rest/v1/users', method)?.operation),
    ['select', 'insert', 'update', 'delete'],
  );
});

test('excludes PostgREST modifiers from filters', () => {
  const request = parseSupabaseRequest(
    'https://project.supabase.co/rest/v1/users?select=id&name=eq.Ada&order=name.asc&limit=10&offset=5',
    'GET',
  );
  assert.deepEqual(request?.filters, [{ name: 'name', value: 'eq.Ada' }]);
});

test('rejects non-Supabase requests and unsupported methods', () => {
  assert.equal(parseSupabaseRequest('https://example.com/rest/v1/users?select=id', 'GET'), null);
  assert.equal(parseSupabaseRequest('https://supabase.co/rest/v1/users?select=id', 'GET'), null);
  assert.equal(parseSupabaseRequest('https://project.supabase.co/rest/v1/users', 'PUT'), null);
  assert.equal(parseSupabaseRequest('/rest/v1/users?select=id', 'GET'), null);
});

test('malformed table encoding is ignored without throwing', () => {
  for (const table of ['%ZZ', '%', '%E0%A4%A']) {
    assert.equal(parseSupabaseRequest(`https://project.supabase.co/rest/v1/${table}`, 'GET'), null);
  }
  assert.equal(parseSupabaseRequest('https://project.supabase.co/rest/v1/order%20items', 'GET')?.table, 'order items');
});
