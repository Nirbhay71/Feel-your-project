// Static: from a route registration to the handler's definition.
//
//   routes/stats.js:7   router.get('/stats', getStats)
//                                            └─ imported from ../controllers/stats.js
//   → controllers/stats.js:3   export function getStats(req, res) {
//
// Handles inline functions, functions declared in the same file, and
// functions imported from another file.

import { traverse, findTopLevelFunction } from './ast.js';
import { loadFile, importTarget } from './files.js';

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

  if (!arg.isIdentifier()) return null; // e.g. controllers.getStats — not followed yet
  const binding = arg.scope.getBinding(arg.node.name);
  if (!binding) return null;

  // Imported: import { getStats } from '../controllers/stats.js'
  if (binding.kind === 'module') {
    const target = importTarget(binding, abs);
    if (!target) return null;
    const { ast: targetAst } = await loadFile(target.file);
    const fn = targetAst && findTopLevelFunction(targetAst, target.name);
    return fn ? { file: target.file, line: fn.node.loc.start.line } : null;
  }

  // Same file: function listNotifications(req, res) { … }
  const fn = findTopLevelFunction(ast, arg.node.name);
  return fn ? { file: abs, line: fn.node.loc.start.line } : null;
}
