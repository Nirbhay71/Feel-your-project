// Rewrites a route file so every handler it exports records itself at
// runtime (server builds only; the browser never sees route files).
//
//   export async function GET(request) {…}         async function GET(request) {…}
//   export const POST = async () => {…}      →     const POST = async () => {…}
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

import MagicString from 'magic-string';
import { parseCode } from '@feel-dev/agent';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const MARK = '__feelWrapRoute';

// info: { kind: 'app' | 'pages', path } from nextRouteInfo.
// Returns { code, map } or null (nothing to wrap, CommonJS, already wrapped).
export function wrapRoute(code, file, info, { runtime = '@feel-dev/next/runtime' } = {}) {
  if (code.includes(MARK)) return null;
  const ast = parseCode(code, file);
  const s = new MagicString(code);
  const wanted = info.kind === 'pages' ? ['default'] : METHODS;
  const wraps = []; // { exported, local, line }
  const imports = []; // appended re-export imports

  for (const stmt of ast.program.body) {
    if (stmt.type === 'ExportNamedDeclaration') unexportDeclaration(stmt, s, wanted, wraps) || removeSpecifiers(stmt, code, s, wanted, wraps, imports);
    else if (stmt.type === 'ExportDefaultDeclaration' && wanted.includes('default')) unexportDefault(stmt, s, wraps);
  }
  if (!wraps.length) return null;

  const wrapper = info.kind === 'pages' ? '__feelWrapPages' : '__feelWrapRoute';
  const lines = [`import { wrapRouteHandler as __feelWrapRoute, wrapPagesHandler as __feelWrapPages } from ${JSON.stringify(runtime)};`, ...imports];
  for (const { exported, local, line, name } of wraps) {
    const meta = JSON.stringify({ file, line, name, path: info.path });
    lines.push(`const __feel_${exported} = ${wrapper}(${local}, ${meta});`);
    lines.push(`export { __feel_${exported} as ${exported} };`);
  }
  s.append(`\n${lines.join('\n')}\n`);
  return { code: s.toString(), map: s.generateMap({ hires: true, source: file }) };
}

// export async function GET() {}   /   export const GET = …, POST = …
// Returns true when the statement was a declaration (handled or not ours).
function unexportDeclaration(stmt, s, wanted, wraps) {
  const decl = stmt.declaration;
  if (!decl) return false;
  const names = [];
  if (decl.type === 'FunctionDeclaration' && wanted.includes(decl.id?.name)) names.push({ name: decl.id.name, line: decl.loc.start.line });
  if (decl.type === 'VariableDeclaration') {
    for (const d of decl.declarations) if (d.id.type === 'Identifier' && wanted.includes(d.id.name)) names.push({ name: d.id.name, line: d.loc.start.line });
    // export const GET = …, dynamic = 'force-dynamic' — only some are ours:
    // un-export all and re-export the others by name.
    const others = decl.declarations.filter((d) => !names.some((n) => n.name === d.id.name)).map((d) => d.id);
    if (names.length && others.length) {
      if (others.some((id) => id.type !== 'Identifier')) return true; // destructuring — leave the file alone
      s.append(`\nexport { ${others.map((id) => id.name).join(', ')} };`);
    }
  }
  if (!names.length) return true;
  s.remove(stmt.start, decl.start); // "export "
  for (const n of names) wraps.push({ exported: n.name, local: n.name, line: n.line, name: n.name });
  return true;
}

// export { handler as GET, other }   /   export { GET } from './shared'
function removeSpecifiers(stmt, code, s, wanted, wraps, imports) {
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
    if (stmt.source) {
      // Import it under a private name, then wrap that.
      const alias = `__feel_src_${exported}`;
      imports.push(`import { ${local === 'default' ? 'default' : local} as ${alias} } from ${JSON.stringify(stmt.source.value)};`);
      local = alias;
    }
    wraps.push({ exported, local, line: spec.loc.start.line, name: exported === 'default' ? spec.local.name : exported });
  }

  // Rewrite the statement with only the specifiers we leave alone, padded
  // with the same number of line breaks so nothing below it moves.
  const breaks = '\n'.repeat((code.slice(stmt.start, stmt.end).match(/\n/g) ?? []).length);
  const from = stmt.source ? ` from ${code.slice(stmt.source.start, stmt.source.end)}` : '';
  const rest = kept.length ? `export { ${kept.map((sp) => code.slice(sp.start, sp.end)).join(', ')} }${from};` : '';
  s.overwrite(stmt.start, stmt.end, rest + breaks || ' ');
}

// Pages Router: export default function handler(req, res) {…}
//   named function/class → drop "export default ", wrap it by name
//   anything else        → "const __feel_default = <it>"
function unexportDefault(stmt, s, wraps) {
  const decl = stmt.declaration;
  const named = (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id;
  const local = named ? decl.id.name : '__feel_default_handler';
  if (named) s.remove(stmt.start, decl.start);
  else {
    s.overwrite(stmt.start, decl.start, `const ${local} = `);
    // "export default function () {}" has no semicolon; a const needs one.
    if (/Declaration$/.test(decl.type)) s.appendLeft(decl.end, ';');
  }
  wraps.push({ exported: 'default', local, line: decl.loc.start.line, name: named ? decl.id.name : 'handler' });
}
