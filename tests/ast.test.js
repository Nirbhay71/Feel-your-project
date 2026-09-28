// How functions get their names — this decides what the panel shows and how
// runtime stack frames are matched to the static call graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCode, traverse, functionName, findTopLevelFunction } from '../packages/agent/src/ast.js';

// The name of the function that starts on the line containing `marker`.
function nameAt(code, marker) {
  const line = code.split('\n').findIndex((l) => l.includes(marker)) + 1;
  let name;
  traverse(parseCode(code, 'x.jsx'), {
    Function(p) {
      if (name === undefined && p.node.loc.start.line === line) name = functionName(p);
    },
  });
  return name;
}

test('declarations, arrows and wrappers (memo, forwardRef, useCallback)', () => {
  assert.equal(nameAt('function Chart() {}', 'Chart'), 'Chart');
  assert.equal(nameAt('const Card = () => null;', 'Card'), 'Card');
  assert.equal(nameAt('const Row = memo(forwardRef(() => null));', 'Row'), 'Row');
  assert.equal(nameAt('function C() {\n  const save = useCallback(() => {}, []); // here\n}', 'here'), 'save');
});

test('object literals: qualified under a top-level const, plain otherwise', () => {
  assert.equal(nameAt('export const dashboardApi = {\n  getAdmin: () => api.get("/x"), // here\n};', 'here'), 'dashboardApi.getAdmin');
  assert.equal(nameAt('module.exports = {\n  getStats: async () => {}, // here\n};', 'here'), 'getStats');
  assert.equal(nameAt('useMutation({\n  onSuccess() {}, // here\n});', 'here'), 'onSuccess');
});

test('CommonJS exports.x = …', () => {
  assert.equal(nameAt('exports.listUsers = async (req, res) => {};', 'listUsers'), 'listUsers');
});

test('callbacks are not named after what setTimeout/.then/.map return', () => {
  assert.equal(nameAt('const timer = setTimeout(() => run(), 500);', 'timer'), null);
  assert.equal(nameAt('const p = fetch(u).then((r) => r.json());', 'then'), null);
  assert.equal(nameAt('const items = list.map((x) => x.id);', 'map'), null);
});

test('findTopLevelFunction: named, default, CommonJS and object members', () => {
  const find = (code, name) => {
    const fn = findTopLevelFunction(parseCode(code, 'x.js'), name);
    return fn ? fn.node.loc.start.line : null;
  };
  assert.equal(find('export default function useApi() {}', 'default'), 1);
  assert.equal(find('function handler() {}\nmodule.exports = handler;', 'default'), 1);
  assert.equal(find('const a = 1;\nexport const api = {\n  getAll: () => 1,\n};', 'api.getAll'), 3);
  assert.equal(find('exports.getX = () => 1;', 'getX'), 1);
  assert.equal(find('const x = 1;', 'x'), null); // not a function
});
