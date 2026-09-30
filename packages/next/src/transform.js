// What the loader does to one file (see loader.cjs):
//
//   1. JSX files: tag DOM elements and components with where they're written —
//      the same tagJsx the Vite plugin uses, so both give identical output.
//      Runs for the server *and* the browser build: both render the same
//      HTML, so hydration sees the same data-src attributes.
//   2. Route files (app/**/route.ts, pages/api/**), server build only: wrap
//      every exported handler so it records itself (wrap-route.js).
//
// Neither moves a line, so stack traces stay right even where a sourcemap
// gets lost between the loader and the browser.

import path from 'node:path';
import { tagJsx, nextRouteInfo } from '@feel-dev/agent';
import { wrapRoute } from './wrap-route.js';

const ALWAYS_JSX = /\.(jsx|tsx)$/;
const MAYBE_JSX = /\.(js|mjs)$/; // .ts can't hold JSX

// root:   the Next project root (paths in tags are relative to it)
// server: true for the Node.js server build (route handlers run there)
// Returns { code, map } — map is null when both steps ran (each keeps
// lines, so line numbers stay right without one) — or null for "unchanged".
export function transformForNext(code, file, { root, server = false, runtime } = {}) {
  if (/[\\/]node_modules[\\/]/.test(file)) return null;
  const rel = path.relative(root, file).split(path.sep).join('/');
  // Files beside the app (a shared folder in a monorepo) are tagged like the
  // Vite plugin tags them ("../shared/Card.jsx:3:5"); only another drive
  // on Windows has no relative path at all.
  if (path.isAbsolute(rel)) return null;

  let out = null;
  let steps = 0;

  // A .js file without a "<" can't hold JSX — skip the parse (most files).
  if (ALWAYS_JSX.test(file) || (MAYBE_JSX.test(file) && /<[A-Za-z>]/.test(code))) {
    out = attempt(() => tagJsx(code, file, { root, requireJsx: !ALWAYS_JSX.test(file) }));
    if (out) steps++;
  }

  const info = server ? nextRouteInfo(rel) : null;
  if (info) {
    const wrapped = attempt(() => wrapRoute(out?.code ?? code, file, info, runtime ? { runtime } : undefined));
    if (wrapped) {
      out = wrapped;
      steps++;
    }
  }

  if (!out) return null;
  return { code: out.code, map: steps === 1 ? out.map : null };
}

// A syntax error (a file mid-edit) is Next's to report, not ours:
// hand the code on untouched.
function attempt(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}
