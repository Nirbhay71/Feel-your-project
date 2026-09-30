// Next.js routes come from files, not from router.get(...) calls.
//
//   app/api/items/route.ts            export async function GET() {…}   → GET  /api/items
//   app/api/items/[id]/route.ts       export async function POST() {…}  → POST /api/items/:id
//   app/(admin)/api/stats/route.js    (group) folders aren't in the URL → GET  /api/stats
//   pages/api/legacy.js               export default function (req, res) → ALL /api/legacy
//
// Paths use the same shape as Express routes (":id", "*"), so the static
// matcher in static.js and the panel compare them without knowing about Next.
// The runtime side (@feel-dev/node's next.js) reports the same shape.

import fs from 'node:fs';
import path from 'node:path';
import { findTopLevelFunction, boundNames } from './ast.js';
import { loadFile, resolveImport } from './files.js';

export const NEXT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const APP_ROUTE = /^(?:src\/)?app\/(?:(.*)\/)?route\.(?:js|jsx|ts|tsx|mjs)$/;
const PAGES_API = /^(?:src\/)?pages\/api(\/.*)?\.(?:js|jsx|ts|tsx|mjs)$/;
const NEXT_CONFIG = ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts', 'next.config.mts'];

// rel: POSIX path relative to the Next project root.
// → { kind: 'app' | 'pages', path, optionalCatchAll? }, or null when the file
//   isn't a route (a private _folder, a @slot, our own agent route, …).
export function nextRouteInfo(rel) {
  const app = rel.match(APP_ROUTE);
  if (app) return routeFromSegments('app', app[1] ? app[1].split('/') : []);
  const pages = rel.match(PAGES_API);
  if (pages) {
    const segs = ['api', ...(pages[1] ?? '').split('/').filter(Boolean)];
    if (segs.at(-1) === 'index') segs.pop();
    return routeFromSegments('pages', segs);
  }
  return null;
}

// Folder names → URL segments, in Next's order of rules.
function routeFromSegments(kind, raw) {
  const out = [];
  let optionalCatchAll = false;
  for (const seg of raw) {
    if (seg.startsWith('_')) return null; // _private folders are never routed
    if (seg.startsWith('@')) return null; // parallel-route slots aren't route handlers
    if (/^\(.*\)$/.test(seg)) continue; // (group) folders don't show in the URL
    if (/^\[\[\.\.\..+\]\]$/.test(seg)) {
      out.push('*');
      optionalCatchAll = true;
    } else if (/^\[\.\.\..+\]$/.test(seg)) out.push('*');
    else if (/^\[.+\]$/.test(seg)) out.push(`:${seg.slice(1, -1)}`);
    else out.push(safeDecode(seg)); // %5F%5Ffeel → __feel
  }
  if (out[0] === '__feel') return null; // our own agent route, not the app's
  return { kind, path: `/${out.join('/')}`, ...(optionalCatchAll && { optionalCatchAll }) };
}

function safeDecode(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

// The Next project a file belongs to: the folder just above its app/ or
// pages/ (or src/app, src/pages) that holds a next.config.*. null for files
// outside a Next app. Cached per folder — scanRoutes asks for every file.
const rootCache = new Map(); // dir → root | null
export function findNextRoot(absFile, projectDir) {
  const dir = path.dirname(absFile);
  if (rootCache.has(dir)) return rootCache.get(dir);

  let found = null;
  const parts = path.relative(projectDir, dir).split(path.sep);
  for (let i = 0; i < parts.length && !found; i++) {
    if (parts[i] !== 'app' && parts[i] !== 'pages') continue;
    const base = parts.slice(0, parts[i - 1] === 'src' ? i - 1 : i);
    const candidate = path.join(projectDir, ...base);
    if (NEXT_CONFIG.some((f) => fs.existsSync(path.join(candidate, f)))) found = candidate;
  }
  rootCache.set(dir, found);
  return found;
}

// The routes one route file defines, in the shape scanRoutes returns.
// Each points straight at its handler (handlerTarget), so describeRoute
// doesn't try to follow a router.get(...) call that isn't there.
export async function nextRoutesIn(file, ast, info) {
  const found = info.kind === 'pages' ? await pagesHandler(file, ast) : await appHandlers(file, ast);
  const routes = [];
  for (const { method, target, line } of found) {
    // line: where the route file exports it — the function's own line when
    // it's written there, else the export (a re-export from another file).
    const route = { file, method, path: info.path, fullPath: info.path, line: line ?? target.line, handlerIndex: 0, direct: true, handlerTarget: target };
    routes.push(route);
    // [[...slug]] also matches the folder itself: /api/docs as well as /api/docs/a/b
    if (info.optionalCatchAll) {
      const bare = info.path.replace(/\/\*$/, '') || '/';
      routes.push({ ...route, path: bare, fullPath: bare });
    }
  }
  return routes;
}

// export async function GET() {}     export const POST = async () => {}
// export { handler as PUT }          export { DELETE } from './shared'
// export const { GET, POST } = handlers   (Auth.js)
// (`export * from …` isn't followed: its names aren't written in the file.)
async function appHandlers(file, ast) {
  const out = [];
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'ExportNamedDeclaration') continue;
    const decl = stmt.declaration;
    if (decl?.type === 'FunctionDeclaration' && NEXT_METHODS.includes(decl.id?.name)) {
      out.push({ method: decl.id.name, target: { file, line: decl.loc.start.line } });
    } else if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        for (const name of boundNames(d.id)) if (NEXT_METHODS.includes(name)) out.push({ method: name, target: { file, line: d.loc.start.line } });
      }
    }
    for (const spec of stmt.specifiers ?? []) {
      const exported = spec.exported?.name ?? spec.exported?.value;
      if (spec.type !== 'ExportSpecifier' || !NEXT_METHODS.includes(exported)) continue;
      const local = spec.local.name ?? spec.local.value;
      const target = stmt.source ? await importedFunction(file, stmt.source.value, local) : localFunction(file, ast, local);
      const exportLine = spec.loc.start.line;
      out.push({ method: exported, target: target ?? { file, line: exportLine }, line: target?.file === file ? target.line : exportLine });
    }
  }
  return out;
}

// Pages Router API routes answer every method from their default export.
async function pagesHandler(file, ast) {
  const fn = findTopLevelFunction(ast, 'default');
  if (fn) return [{ method: 'ALL', target: { file, line: fn.node.loc.start.line } }];
  const stmt = ast.program.body.find((s) => s.type === 'ExportDefaultDeclaration');
  return stmt ? [{ method: 'ALL', target: { file, line: stmt.loc.start.line } }] : [];
}

function localFunction(file, ast, name) {
  const fn = findTopLevelFunction(ast, name);
  return fn ? { file, line: fn.node.loc.start.line } : null;
}

async function importedFunction(file, specifier, name) {
  const target = resolveImport(file, specifier);
  if (!target) return null;
  const loaded = await loadFile(target).catch(() => null);
  return loaded?.ast ? localFunction(target, loaded.ast, name) : null;
}
