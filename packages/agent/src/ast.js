// Shared AST helpers, used by both the Vite plugin (tagging) and the
// source handler (finding a component's line range).

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
  let fn = p.isFunction() ? p : p.getFunctionParent();
  while (fn) {
    const name = functionName(fn);
    if (name && /^[A-Z]/.test(name)) return fn;
    fn = fn.getFunctionParent();
  }
  return null;
}

export function functionName(fn) {
  if (fn.node.id?.name) return fn.node.id.name;

  // Climb through wrapper calls like memo(...) / forwardRef(...).
  let parent = fn.parentPath;
  while (parent?.isCallExpression()) parent = parent.parentPath;

  if (parent?.isVariableDeclarator() && parent.node.id.type === 'Identifier') {
    return parent.node.id.name;
  }
  return null;
}
