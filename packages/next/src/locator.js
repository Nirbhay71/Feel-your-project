// Where a browser stack frame really is, under `next dev`.
//
// The browser runs bundles, and the two bundlers name them differently:
//
//   Turbopack  http://localhost:3000/_next/static/chunks/0f3a…_.js:120:15
//              → the chunk's sourcemap is served right next to it (.js.map),
//                as a "sectioned" map with file:///abs/path sources
//   webpack    webpack-internal:///(app-pages-browser)/./lib/api.js:4:10
//              → one module per name; Next's /__nextjs_source-map endpoint
//                hands out its map (sources like webpack://_N_E/./lib/api.js)
//
// Maps are always fetched from this dev server (`origin`: the address and
// port the agent's request came in on, see agent.js), never from a host named
// in the stack text — the stack comes from the browser and could point anywhere.
// With a basePath, everything above sits under it (/docs/_next/…).
//
// Plugs into @feel-dev/agent's resolveStack as its `locate` function.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceMap, FlattenMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { libraryName } from '@feel-dev/agent';

// root:     the Next project root (webpack sources are relative to it)
// basePath: Next's basePath ('' when none) — bundles are served under it
// fetch:    injectable for tests
// ttl:      how long a map is reused — chunk names survive a hot reload,
//           their contents don't, so keep it short
// timeout:  a map that takes longer than this is given up on (ms)
export function createNextLocator({ root, basePath = '', fetch = globalThis.fetch, ttl = 2000, timeout = 5000 }) {
  const cache = new Map(); // URL → { at, promise }, oldest first
  const cached = (url, load) => {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttl) return hit.promise;
    cache.delete(url); // re-inserted below as the newest
    const promise = load(url);
    cache.set(url, { at: Date.now(), promise });
    // A long session touches many chunks; keep only the most recent ones.
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
    return promise;
  };
  const mapAt = (url) => cached(`map ${url}`, () => loadMap(fetch, url, timeout));
  const textAt = (url) => cached(`text ${url}`, () => loadText(fetch, url, timeout));
  const bundles = `${basePath}/_next/`;

  return async function locate(raw, line, column, { origin } = {}) {
    if (!origin) return null;
    if (raw.startsWith('webpack-internal:///')) {
      if (raw.includes('/node_modules/')) return { lib: libraryName(raw) };
      return mapped(await mapAt(`${origin}${basePath}/__nextjs_source-map?filename=${encodeURIComponent(raw)}`), line, column, root);
    }

    let url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (!url.pathname.startsWith(bundles)) return null; // not a bundle of this app
    // Turbopack puts code that's only packages in chunks named after them.
    if (/\/node_modules_[^/]*$/.test(url.pathname)) return { lib: null };
    const chunk = `${origin}${url.pathname}`;
    const moduleId = url.searchParams.get('id');
    if (moduleId) return hotModule({ moduleId, chunk, line, column, root, mapAt, textAt });
    return mapped(await mapAt(`${chunk}.map`), line, column, root);
  };
}

const MAX_CACHED = 50;

// A position in a bundle → { file, line, column } in your code, or null.
function mapped(map, line, column, root) {
  if (!map) return null;
  const pos = originalPositionFor(map, { line, column: Math.max(column - 1, 0) });
  if (pos.source == null || pos.line == null) return null;
  const file = normalizeSource(pos.source, root);
  if (!file) return null; // Next's own runtime
  return { file, line: pos.line, column: pos.column + 1 };
}

// Turbopack, after a hot reload: the new code of one module runs from
//   …/chunks/app.js?id=%255Bproject%255D/lib/api.js+%255Bapp-client%255D+(ecmascript):19:12
// and its line numbers count from that module's first line, not the chunk's.
// The chunk served now holds the same new code, starting at the line that
// names the module — so the frame is that line + (line - 1) in the chunk.
// Whatever happens, the frame keeps its file (the id says which): with no
// trustworthy line, resolveStack falls back to the function's name.
async function hotModule({ moduleId, chunk, line, column, root, mapAt, textAt }) {
  const id = safeDecode(moduleId); // "[project]/lib/api.js [app-client] (ecmascript)"
  const rel = id.match(/^\[project\]\/([^ ]+)/)?.[1];
  if (!rel) return null;
  const file = path.resolve(root, rel);
  if (/[\\/]node_modules[\\/]/.test(file)) return { lib: libraryName(`/${rel}`) };

  const [text, map] = await Promise.all([textAt(chunk), mapAt(`${chunk}.map`)]);
  // The module's definition starts its line with the id; imports of it
  // elsewhere in the chunk mention the id mid-line.
  const start = text ? text.split('\n').findIndex((l) => l.startsWith(`${JSON.stringify(id)},`)) : -1;
  if (start >= 0) {
    const pos = mapped(map, start + line, column, root);
    if (pos?.file === file) return pos;
  }
  return { file, line: null, column: null };
}

// The id is URL-encoded twice (%255B → %5B → [).
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function loadMap(fetch, url, timeout) {
  const text = await loadText(fetch, url, timeout);
  if (!text) return null;
  try {
    const json = JSON.parse(text);
    return json.sections ? new FlattenMap(json) : new TraceMap(json);
  } catch {
    return null;
  }
}

// The body of a URL on the dev server, or null (missing, too slow, broken).
async function loadText(fetch, url, timeout) {
  try {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeout) });
    if (!res.ok || res.status === 204) return null;
    return (await res.text()) || null;
  } catch {
    return null;
  }
}

// A source name from a map → absolute file path, or null when it's the
// bundler's own code. Package files come out as paths with node_modules in
// them, which resolveStack then treats as a library.
//   file:///app/lib/api.js                                   → /app/lib/api.js
//   turbopack:///[project]/lib/api.js                        → <root>/lib/api.js
//   webpack://_N_E/./lib/api.js?1234                         → <root>/lib/api.js
//   webpack://_N_E/lib/api.js                                → <root>/lib/api.js
//   webpack://./lib/api.js                                   → <root>/lib/api.js
//   webpack-internal:///(app-pages-browser)/./lib/api.js     → <root>/lib/api.js
//   webpack://javascript/auto|./node_modules/react-dom/…|app-pages-browser → <root>/node_modules/react-dom/…
//   webpack://next/src/client/…, turbopack:///[turbopack]/…  → null
export function normalizeSource(source, root) {
  if (source.startsWith('file://')) {
    try {
      return fileURLToPath(source);
    } catch {
      return null;
    }
  }
  if (source.startsWith('turbopack:///[project]/')) return path.resolve(root, source.slice('turbopack:///[project]/'.length));
  if (source.startsWith('turbopack:')) return null;

  let rest = null;
  if (source.startsWith('webpack-internal:///')) rest = source.slice('webpack-internal:///'.length);
  else if (source.startsWith('webpack://')) {
    rest = source.slice('webpack://'.length);
    const parts = rest.split('|');
    if (parts.length === 3) rest = parts[1]; // javascript/auto|<module>|<layer>
    else if (!/^\.\.?\//.test(rest)) {
      // webpack://<namespace>/<module>. "next" is Next's own code and
      // webpack/… the bundler runtime; for the rest the "./" may already
      // have been normalised away (webpack://_N_E/lib/api.js).
      const slash = rest.indexOf('/');
      const namespace = rest.slice(0, slash);
      rest = rest.slice(slash + 1);
      if (namespace === 'next' || rest.startsWith('webpack/')) return null;
      if (!/^\.\.?\//.test(rest)) rest = `./${rest}`;
    }
  }
  if (rest != null) {
    rest = rest.split('?')[0].replace(/^\([^)]*\)\//, ''); // (app-pages-browser)/
    return /^\.\.?\//.test(rest) ? path.resolve(root, rest) : null;
  }
  return path.isAbsolute(source) ? source : null;
}
