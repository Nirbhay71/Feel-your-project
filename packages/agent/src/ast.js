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

  // Climb through wrapper calls like memo(...) / forwardRef(...).
  let parent = fn.parentPath;
  while (parent?.isCallExpression()) parent = parent.parentPath;

  if (parent?.isVariableDeclarator() && parent.node.id.type === 'Identifier') {
    return parent.node.id.name;
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
    Function(p) {
      if (p.getFunctionParent() || functionName(p) !== name) return;
      found = p;
      p.stop();
    },
  });

  if (!found && defaultLocal) return findTopLevelFunction(ast, defaultLocal);
  return found;
}
