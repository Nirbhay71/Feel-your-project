// Static: from a route registration to the handler's definition.
//
//   routes/stats.js:7   router.get('/stats', getStats)
//                                            └─ imported from ../controllers/stats.js
//   → controllers/stats.js:3   export function getStats(req, res) {
//
// Handles inline functions, functions declared in the same file, and
// functions imported from another file.

import { traverse, findTopLevelFunction } from './ast.js';
import { loadFile, refTarget } from './files.js';

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use']);

// index = which handler in the call (0 for the first function argument).
// Returns { file, line } or null if it can't be followed.
export async function resolveHandler(abs, line, index = 0) {
  const { ast } = await loadFile(abs);
  if (!ast) return null;

  // The innermost `something.get(...)` call that spans this line.
  let call = null;
  traverse(ast, {
    CallExpression(p) {
      const { callee, loc } = p.node;
      if (callee.type !== 'MemberExpression' || !ROUTE_METHODS.has(callee.property.name)) return;
      if (loc.start.line <= line && line <= loc.end.line) call = p;
    },
  });
  if (!call) return null;

  // Drop the path argument ('/stats'); what's left are the handlers.
  const handlers = call
    .get('arguments')
    .filter((a) => !a.isStringLiteral() && !a.isTemplateLiteral() && !a.isRegExpLiteral());
  const arg = handlers[index] ?? handlers[handlers.length - 1];
  if (!arg) return null;

  // Inline: router.get('/x', (req, res) => { … })
  if (arg.isFunction()) return { file: abs, line: arg.node.loc.start.line };

  // Everything else is a reference to a function declared elsewhere:
  //   getStats            same file, or import { getStats } / const { getStats } = require(…)
  //   ctrl.getStats       const ctrl = require('../controllers/stats')
  //   handlers.getStats   an object of handlers, here or imported
  const target = refTarget(arg, abs);
  if (!target) return null;
  const { ast: targetAst } = target.file === abs ? { ast } : await loadFile(target.file);
  const fn = targetAst && findTopLevelFunction(targetAst, target.name);
  return fn ? { file: target.file, line: fn.node.loc.start.line } : null;
}
