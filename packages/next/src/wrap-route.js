// Rewrites a route file so every handler it exports records itself at
// runtime (server builds only; the browser never sees route files).
//
//   export async function GET(request) {…}         async function GET(request) {…}
//   export const POST = async () => {…}      →     const POST = async () => {…}
//   export const { GET, POST } = handlers          const { GET, POST } = handlers
//   export { handler as PUT }                      (specifier removed)
//   export { DELETE } from './shared'              (specifier removed)
//   …
//   import { wrapRouteHandler as __feelWrapRoute, … } from '@feel-dev/next/runtime';
//   const __feel_GET = __feelWrapRoute(GET, { file, line, name: 'GET', path: '/api/items' });
//   export { __feel_GET as GET };
//
// Pages Router API routes (pages/api/**) get the same for their default export.
// Only `export` keywords are removed and code is appended at the end, so no
// line moves: stack traces and the sourcemap stay simple.
//
// Each wrapper is told where its handler is written — the function itself,
// even when it's re-exported from another file — which is the same place the
// static scan (@feel-dev/agent's next-routes.js) reports.
//
// Not wrapped: `export * from './handlers'` (the names aren't in this file)
// and `export let GET` reassigned later (the wrapper would keep the first value).

import fs from 'node:fs';
import MagicString from 'magic-string';
import { parseCode, findTopLevelFunction, resolveImport, boundNames } from '@feel-dev/agent';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const MARK = '__feelWrapRoute';

// info: { kind: 'app' | 'pages', path } from nextRouteInfo.
// Returns { code, map } or null (nothing to wrap, CommonJS, already wrapped).
export function wrapRoute(code, file, info, { runtime = '@feel-dev/next/runtime' } = {}) {
  if (code.includes(MARK)) return null;
  const ast = parseCode(code, file);
  const s = new MagicString(code);
  const wanted = info.kind === 'pages' ? ['default'] : METHODS;
  const wraps = []; // { exported, local, line, name, file? }
  const imports = []; // appended re-export imports

  for (const stmt of ast.program.body) {
    if (stmt.type === 'ExportNamedDeclaration') unexportDeclaration(stmt, s, wanted, wraps) || removeSpecifiers(stmt, code, s, wanted, wraps, imports, ast, file);
    else if (stmt.type === 'ExportDefaultDeclaration' && wanted.includes('default')) unexportDefault(stmt, s, wraps, ast);
  }
  if (!wraps.length) return null;

  const wrapper = info.kind === 'pages' ? '__feelWrapPages' : '__feelWrapRoute';
  const lines = [`import { wrapRouteHandler as __feelWrapRoute, wrapPagesHandler as __feelWrapPages } from ${JSON.stringify(runtime)};`, ...imports];
  for (const { exported, local, line, name, file: where = file } of wraps) {
    const meta = JSON.stringify({ file: where, line, name, path: info.path });
    lines.push(`const __feel_${exported} = ${wrapper}(${local}, ${meta});`);
    lines.push(`export { __feel_${exported} as ${exported} };`);
  }
  s.append(`\n${lines.join('\n')}\n`);
  return { code: s.toString(), map: s.generateMap({ hires: true, source: file }) };
}

// export async function GET() {}   /   export const GET = …, POST = …
// export const { GET, POST } = handlers   (Auth.js: NextAuth(…).handlers)
// Returns true when the statement was a declaration (handled or not ours).
function unexportDeclaration(stmt, s, wanted, wraps) {
  const decl = stmt.declaration;
  if (!decl) return false;
  const names = [];
  if (decl.type === 'FunctionDeclaration' && wanted.includes(decl.id?.name)) names.push({ name: decl.id.name, line: decl.loc.start.line });
  if (decl.type === 'VariableDeclaration') {
    const bound = decl.declarations.flatMap((d) => boundNames(d.id).map((name) => ({ name, line: d.loc.start.line })));
    names.push(...bound.filter((b) => wanted.includes(b.name)));
    // export const GET = …, dynamic = 'force-dynamic' — only some are ours:
    // un-export all and re-export the others by name.
    const others = bound.filter((b) => !wanted.includes(b.name)).map((b) => b.name);
    if (names.length && others.length) s.append(`\nexport { ${others.join(', ')} };`);
  }
  if (!names.length) return true;
  s.remove(stmt.start, decl.start); // "export "
  for (const n of names) wraps.push({ exported: n.name, local: n.name, line: n.line, name: n.name });
  return true;
}

// export { handler as GET, other }   /   export { GET } from './shared'
function removeSpecifiers(stmt, code, s, wanted, wraps, imports, ast, file) {
  const ours = [];
  const kept = [];
  for (const spec of stmt.specifiers ?? []) {
    const exported = spec.exported?.name ?? spec.exported?.value;
    if (spec.type === 'ExportSpecifier' && wanted.includes(exported) && spec.local.type === 'Identifier') ours.push({ spec, exported });
    else kept.push(spec);
  }
  if (!ours.length) return;

  for (const { spec, exported } of ours) {
    let local = spec.local.name;
    // Point at the function itself — in this file, or in the one it's
    // re-exported from — else at the export.
    const target = stmt.source ? importedFunction(file, stmt.source.value, local) : localLine(ast, local, file);
    if (stmt.source) {
      // Import it under a private name, then wrap that.
      const alias = `__feel_src_${exported}`;
      imports.push(`import { ${local === 'default' ? 'default' : local} as ${alias} } from ${JSON.stringify(stmt.source.value)};`);
      local = alias;
    }
    wraps.push({ exported, local, name: exported === 'default' ? spec.local.name : exported, ...(target ?? { line: spec.loc.start.line }) });
  }

  // Rewrite the statement with only the specifiers we leave alone, padded
  // with the same number of line breaks so nothing below it moves.
  const breaks = '\n'.repeat((code.slice(stmt.start, stmt.end).match(/\n/g) ?? []).length);
  const from = stmt.source ? ` from ${code.slice(stmt.source.start, stmt.source.end)}` : '';
  const rest = kept.length ? `export { ${kept.map((sp) => code.slice(sp.start, sp.end)).join(', ')} }${from};` : '';
  s.overwrite(stmt.start, stmt.end, rest + breaks || ' ');
}

// The line of a top-level `function name` / `const name =` in the file.
function declarationLine(ast, name) {
  for (let stmt of ast.program.body) {
    if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) stmt = stmt.declaration;
    if (stmt.type === 'FunctionDeclaration' && stmt.id?.name === name) return stmt.loc.start.line;
    if (stmt.type === 'VariableDeclaration') {
      const d = stmt.declarations.find((x) => boundNames(x.id).includes(name));
      if (d) return d.loc.start.line;
    }
  }
  return null;
}

const localLine = (ast, name, file) => {
  const line = declarationLine(ast, name);
  return line ? { file, line } : null;
};

// export { sharedGet as GET } from '../lib/handlers' → where sharedGet is
// written in handlers.js, as { file, line }; null when it can't be found.
function importedFunction(file, specifier, name) {
  try {
    const target = resolveImport(file, specifier);
    if (!target) return null;
    const fn = findTopLevelFunction(parseCode(fs.readFileSync(target, 'utf8'), target), name);
    return fn ? { file: target, line: fn.node.loc.start.line } : null;
  } catch {
    return null;
  }
}

// Pages Router: export default function handler(req, res) {…}
//   named function/class → drop "export default ", wrap it by name
//   export default handler; → wrap handler, at the line it's declared
//   anything else        → "const __feel_default = <it>"
function unexportDefault(stmt, s, wraps, ast) {
  const decl = stmt.declaration;
  const named = (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id;
  const local = named ? decl.id.name : '__feel_default_handler';
  if (named) s.remove(stmt.start, decl.start);
  else {
    s.overwrite(stmt.start, decl.start, `const ${local} = `);
    // "export default function () {}" has no semicolon; a const needs one.
    if (/Declaration$/.test(decl.type)) s.appendLeft(decl.end, ';');
  }
  const byName = decl.type === 'Identifier' ? decl.name : null;
  const line = (byName && declarationLine(ast, byName)) || decl.loc.start.line;
  wraps.push({ exported: 'default', local, line, name: named ? decl.id.name : (byName ?? 'handler') });
}
