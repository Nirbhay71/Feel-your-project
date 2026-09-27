// Reading, parsing (with a cache) and import resolution.

import fs from 'node:fs';
import { parseCode } from './ast.js';
import { resolveImport } from './resolve.js';

const cache = new Map(); // abs path → { mtimeMs, code, ast }

// Read + parse a file. Re-parses only when the file changed on disk.
// `ast` is null if the file has a syntax error (e.g. mid-edit).
export async function loadFile(abs) {
  const { mtimeMs } = await fs.promises.stat(abs);
  const hit = cache.get(abs);
  if (hit?.mtimeMs === mtimeMs) return hit;

  const code = await fs.promises.readFile(abs, 'utf8');
  let ast = null;
  try {
    ast = parseCode(code, abs);
  } catch {
    // leave ast null
  }
  const entry = { mtimeMs, code, ast };
  cache.set(abs, entry);
  return entry;
}

// Relative imports, Vite aliases, tsconfig paths, package.json "imports" —
// see resolve.js. Packages ("react") return null.
export { resolveImport } from './resolve.js';

// For a binding that comes from another file, return { file, name } of what it
// points to — ES imports and CommonJS require() alike. name "*" = the whole module.
//   import useApi from '../hooks/useApi.js'        → { …/useApi.js,    name: 'default' }
//   import { fetchSales } from '../api.js'         → { …/api.js,       name: 'fetchSales' }
//   import * as api from '../api.js'               → { …/api.js,       name: '*' }
//   const ctrl = require('../controllers/x')       → { …/x.js,         name: '*' }
//   const { getStats } = require('../controllers/x') → { …/x.js,       name: 'getStats' }
//   const getStats = require('../controllers/x').getStats → same
export function importTarget(binding, fromAbs) {
  const p = binding.path;
  let specifier = null;
  let name = null;

  if (p.isImportDefaultSpecifier() || p.isImportSpecifier() || p.isImportNamespaceSpecifier()) {
    specifier = p.parent.source.value;
    name = p.isImportDefaultSpecifier() ? 'default' : p.isImportNamespaceSpecifier() ? '*' : (p.node.imported.name ?? p.node.imported.value);
  } else if (p.isVariableDeclarator()) {
    const req = requireOf(p.node.init);
    if (!req) return null;
    specifier = req.specifier;
    if (p.node.id.type === 'Identifier') {
      name = req.prop ?? '*';
    } else if (p.node.id.type === 'ObjectPattern' && !req.prop) {
      const prop = p.node.id.properties.find((pr) => pr.value?.type === 'Identifier' && pr.value.name === binding.identifier.name);
      name = prop && (prop.key.name ?? prop.key.value);
    }
  }
  if (!specifier || !name) return null;

  const file = resolveImport(fromAbs, specifier);
  return file ? { file, name } : null;
}

// require('x') → { specifier: 'x' };  require('x').y → { specifier: 'x', prop: 'y' }
function requireOf(node) {
  if (node?.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments[0]?.type === 'StringLiteral') {
    return { specifier: node.arguments[0].value };
  }
  if (node?.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    const inner = requireOf(node.object);
    if (inner && !inner.prop) return { ...inner, prop: node.property.name };
  }
  return null;
}

// What a reference in code points to — a plain name or obj.prop — as the
// { file, name } that findTopLevelFunction understands. null if it isn't
// something declared at the top of this file or imported/required.
//   getStats                  (local or imported)      → { file, name: 'getStats' }
//   ctrl.getStats             (ctrl = require(…))      → { controller file, name: 'getStats' }
//   dashboardApi.getAdmin     (imported object)        → { services file, name: 'dashboardApi.getAdmin' }
export function refTarget(p, file) {
  let id = p;
  let member = null;
  if (p.isMemberExpression()) {
    if (p.node.computed || !p.get('object').isIdentifier() || p.node.property.type !== 'Identifier') return null;
    id = p.get('object');
    member = p.node.property.name;
  } else if (!p.isIdentifier()) {
    return null;
  }

  const binding = id.scope.getBinding(id.node.name);
  if (!binding) return null;
  const target = importTarget(binding, file);
  if (target) {
    if (!member) return target;
    // A whole module (require / namespace / default export object) → its export by that name.
    const whole = target.name === '*' || target.name === 'default';
    return { file: target.file, name: whole ? member : `${target.name}.${member}` };
  }
  if (binding.scope.path.isProgram()) return { file, name: member ? `${id.node.name}.${member}` : id.node.name };
  return null;
}
