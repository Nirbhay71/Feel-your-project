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
// Maps are always fetched from the dev server that sent the request (the
// request's own origin), never from a host named in the stack text — the
// stack comes from the browser and could point anywhere.
//
// Plugs into @feel-dev/agent's resolveStack as its `locate` function.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceMap, FlattenMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { libraryName } from '@feel-dev/agent';

// root:  the Next project root (webpack sources are relative to it)
// fetch: injectable for tests
// ttl:   how long a map is reused — chunk names survive a hot reload, their
//        contents don't, so keep it short
export function createNextLocator({ root, fetch = globalThis.fetch, ttl = 2000 }) {
  const cache = new Map(); // map URL → { at, promise }

  const mapAt = (url) => {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttl) return hit.promise;
    const promise = loadMap(fetch, url);
    cache.set(url, { at: Date.now(), promise });
    return promise;
  };

  return async function locate(raw, line, column, { origin } = {}) {
    if (!origin) return null;
    let mapUrl;
    if (raw.startsWith('webpack-internal:///')) {
      if (raw.includes('/node_modules/')) return { lib: libraryName(raw) };
      mapUrl = `${origin}/__nextjs_source-map?filename=${encodeURIComponent(raw)}`;
    } else {
      let pathname;
      try {
        pathname = new URL(raw).pathname;
      } catch {
        return null;
      }
      if (!pathname.startsWith('/_next/')) return null; // not a bundle of this app
      // Turbopack puts code that's only packages in chunks named after them.
      if (/\/node_modules_[^/]*$/.test(pathname)) return { lib: null };
      mapUrl = `${origin}${pathname}.map`;
    }

    const map = await mapAt(mapUrl);
    if (!map) return null;
    const pos = originalPositionFor(map, { line, column: Math.max(column - 1, 0) });
    if (pos.source == null || pos.line == null) return null;
    const file = normalizeSource(pos.source, root);
    if (!file) return null; // Next's own runtime
    return { file, line: pos.line, column: pos.column + 1 };
  };
}

async function loadMap(fetch, url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok || res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    const json = JSON.parse(text);
    return json.sections ? new FlattenMap(json) : new TraceMap(json);
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
    else if (!/^\.\.?\//.test(rest)) rest = rest.slice(rest.indexOf('/') + 1); // drop the namespace
  }
  if (rest != null) {
    rest = rest.split('?')[0].replace(/^\([^)]*\)\//, ''); // (app-pages-browser)/
    return /^\.\.?\//.test(rest) ? path.resolve(root, rest) : null;
  }
  return path.isAbsolute(source) ? source : null;
}
