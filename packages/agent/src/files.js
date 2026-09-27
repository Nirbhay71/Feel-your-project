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

// For an identifier that was imported, return { file, name } of what it points to.
//   import useApi from '../hooks/useApi.js'  → { file: …/useApi.js, name: 'default' }
//   import { fetchSales } from '../api.js'   → { file: …/api.js,    name: 'fetchSales' }
export function importTarget(binding, fromAbs) {
  const spec = binding.path;
  let name = null;
  if (spec.isImportDefaultSpecifier()) name = 'default';
  else if (spec.isImportSpecifier()) name = spec.node.imported.name ?? spec.node.imported.value;
  if (!name) return null; // namespace imports (import * as x) aren't followed

  const file = resolveImport(fromAbs, spec.parent.source.value);
  return file ? { file, name } : null;
}
