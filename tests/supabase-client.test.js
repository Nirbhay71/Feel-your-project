import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseSupabaseRequest } from '../packages/client/src/supabase.js';

const networkSource = fs.readFileSync(new URL('../packages/client/src/network.js', import.meta.url), 'utf8')
  .replace("import { parseSupabaseRequest } from './supabase.js';", '')
  .replace('export { parseSupabaseRequest };', '')
  .replace(/\bexport /g, '');

// Run the real network wrappers with browser transports that never use the network.
test('fetch and XHR still send requests with malformed Supabase table names', async () => {
  const sent = [];
  const response = { status: 200, headers: { get: () => null }, json: async () => ({ frames: [] }) };
  class XMLHttpRequest {
    open(method, url) { this.url = url; }
    send() { sent.push(this.url); }
    addEventListener() {}
  }
  const window = { fetch: async (url) => { sent.push(url); return response; } };
  const context = vm.createContext({ window, XMLHttpRequest, parseSupabaseRequest, performance });
  vm.runInContext(networkSource, context);

  const url = 'https://project.supabase.co/rest/v1/%ZZ';
  assert.equal(await window.fetch(url), response);
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url);
  xhr.send();
  assert.equal(sent.filter((value) => value === url).length, 2);
  assert.equal(vm.runInContext('getRequests()[0].supabase', context), null);
});

const panelSource = fs.readFileSync(new URL('../packages/client/src/panel.js', import.meta.url), 'utf8');
// Isolate the actual request renderer from the panel's browser startup code.
const requestRenderer = panelSource.slice(panelSource.indexOf('function renderRequest('), panelSource.indexOf('// Changed:'));
function el(tag, props = {}, ...children) {
  return { tag, ...props, children, append(...more) { this.children.push(...more); } };
}
function descendants(node) {
  return typeof node === 'object' ? [node, ...node.children.flatMap(descendants)] : [];
}

test('Supabase list shows its table link without backend installation advice', () => {
  let opened;
  const context = vm.createContext({ el, showTable: (name) => { opened = name; } });
  vm.runInContext(requestRenderer, context);
  const request = { method: 'GET', url: 'https://project.supabase.co/rest/v1/users', status: 200, duration: 1, frames: [], backend: null };
  context.req = { ...request, supabase: parseSupabaseRequest(request.url, request.method) };
  const nodes = descendants(vm.runInContext('renderRequest(req, 1)', context));
  assert.ok(nodes.some((node) => node.textContent === 'Supabase'));
  assert.ok(!nodes.some((node) => node.textContent === 'Backend'));
  const tableLink = nodes.find((node) => node.tag === 'button' && node.textContent === 'users');
  assert.ok(tableLink);
  tableLink.onclick();
  assert.equal(opened, 'users');

  context.req = request;
  const ordinary = descendants(vm.runInContext('renderRequest(req, 1)', context));
  assert.ok(ordinary.some((node) => node.textContent === 'not instrumented (add @feel-dev/node)'));
});
