// Shared AST helpers, used by both the Vite plugin (tagging) and the agent.

import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

// @babel/traverse is CommonJS; under ESM the function sits on .default.
export const traverse = _traverse.default ?? _traverse;

export function parseCode(code, file) {
  return parse(code, {
    sourceType: 'module',
    plugins: /\.tsx?$/.test(file) ? ['jsx', 'typescript'] : ['jsx'],
  });
}

// Walk up from a path to the nearest function that looks like a component:
//   function Chart() {}            → "Chart"
//   const Chart = () => {}         → "Chart"
//   const Chart = memo(() => {})   → "Chart"
// Lowercase or anonymous functions (e.g. a .map callback) are skipped.
// Returns the function's path, or null.
export function findComponent(p) {
  return findEnclosing(p, (name) => /^[A-Z]/.test(name));
}

// Like findComponent, but any named function counts (fetchSales, useApi, …).
export function findNamedFunction(p) {
  return findEnclosing(p, () => true);
}

function findEnclosing(p, accept) {
  let fn = p.isFunction() ? p : p.getFunctionParent();
  while (fn) {
    const name = functionName(fn);
    if (name && accept(name)) return fn;
    fn = fn.getFunctionParent();
  }
  return null;
}

export function functionName(fn) {
  if (fn.node.id?.name) return fn.node.id.name;

  // Climb through wrapper calls like memo(...) / forwardRef(...) /
  // useCallback(...) / debounce(...) — they return (a version of) the function.
  // Not through calls that just *run* it later and return something else:
  //   const timer = setTimeout(() => …)   →  the arrow isn't "timer"
  let parent = fn.parentPath;
  while (parent?.isCallExpression()) {
    if (NOT_A_WRAPPER.test(calleeName(parent.node.callee))) return null;
    parent = parent.parentPath;
  }

  if (parent?.isVariableDeclarator() && parent.node.id.type === 'Identifier') {
    return parent.node.id.name;
  }

  // Functions inside an object literal, not through a wrapper call:
  //   export const dashboardApi = { getAdmin: () => … }  → "dashboardApi.getAdmin"
  //   module.exports = { getStats: async () => … }        → "getStats"
  //   useMutation({ onSuccess: () => … })                 → "onSuccess"
  const prop = fn.isObjectMethod() ? fn : fn.parentPath.isObjectProperty() && fn.parentPath.node.value === fn.node ? fn.parentPath : null;
  const key = prop && (prop.node.key.type === 'Identifier' ? prop.node.key.name : prop.node.key.value);
  if (typeof key === 'string' && !prop.node.computed) {
    const holder = prop.parentPath.parentPath; // ObjectExpression → what holds it
    const topLevelConst = holder?.isVariableDeclarator() && holder.node.id.type === 'Identifier' && !holder.getFunctionParent();
    return topLevelConst ? `${holder.node.id.name}.${key}` : key;
  }

  // exports.getStats = async () => …   /   module.exports.getStats = …
  if (fn.parentPath.isAssignmentExpression() && fn.parentPath.node.right === fn.node) {
    const left = fn.parentPath.node.left;
    if (left.type === 'MemberExpression' && !left.computed && left.property.type === 'Identifier') return left.property.name;
  }
  return null;
}

// The innermost function whose body spans `line`, or null.
export function functionAtLine(ast, line) {
  let innermost = null;
  traverse(ast, {
    Function(p) {
      const { start, end } = p.node.loc;
      if (start.line <= line && line <= end.line) innermost = p; // deeper matches win
    },
  });
  return innermost;
}

// Find a top-level function by name. "default" means the default export.
//   export function getStats() {}          → getStats
//   export const fetchSales = () => …      → fetchSales
//   export default function useApi() {}    → default
//   module.exports = useApi                 → default   (CommonJS)
//   export const api = { getAll: () => … }  → api.getAll
export function findTopLevelFunction(ast, name) {
  let found = null;
  let defaultLocal = null;

  traverse(ast, {
    ExportDefaultDeclaration(p) {
      if (name !== 'default') return;
      const decl = p.get('declaration');
      if (decl.isFunction()) found = decl;
      else if (decl.isIdentifier()) defaultLocal = decl.node.name; // export default Foo;
      p.stop();
    },
    AssignmentExpression(p) {
      if (name !== 'default' || !isModuleExports(p.node.left)) return;
      const right = p.get('right');
      if (right.isFunction()) found = right;
      else if (right.isIdentifier()) defaultLocal = right.node.name; // module.exports = foo;
      if (found || defaultLocal) p.stop();
    },
    Function(p) {
      if (p.getFunctionParent() || functionName(p) !== name) return;
      found = p;
      p.stop();
    },
  });

  if (!found && defaultLocal) return findTopLevelFunction(ast, defaultLocal);
  return found;
}

// Calls that take a callback but return something that isn't that callback.
const NOT_A_WRAPPER = /^(setTimeout|setInterval|setImmediate|requestAnimationFrame|requestIdleCallback|queueMicrotask|then|catch|finally|map|forEach|filter|reduce|find|findIndex|some|every|flatMap|sort|addEventListener|removeEventListener|on|once|subscribe)$/;

// foo(...) → "foo";  a.b.foo(...) → "foo";  anything else → ""
function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return callee.property.name;
  return '';
}

const isModuleExports = (node) =>
  node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.object.name === 'module' && node.property.name === 'exports';
