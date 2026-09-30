// Turn a browser stack trace into original source locations.
//
// The browser runs code that Vite (or Next.js) has transformed, so a stack line like
//   at fetchSales (http://localhost:5173/src/api.js?t=172:8:34)
// points into the *transformed* file. The dev server keeps a sourcemap for
// every module it served; a "locator" uses it to map back to the line you
// actually wrote, then we look up which function and component that line
// belongs to. Where the maps come from differs per dev server, so the
// locator is passed in (Vite's is below, Next's is in @feel-dev/next).

import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { functionAtLine, findNamedFunction, findComponent, functionName } from './ast.js';
import { loadFile } from './files.js';

// Matches the "url:line:col" at the end of a Chrome or Firefox stack line.
// Next's webpack mode names modules webpack-internal:///(app-pages-browser)/./lib/api.js
// — kept as the raw text, because new URL() would drop the "./" and the
// dev server only finds the module by its exact name.
const FRAME = /(https?:\/\/[^\s()]+?|webpack-internal:\/\/\/\S+?):(\d+):(\d+)\)?\s*$/;

// Frames from these URLs are libraries or our own tooling — skip them.
const IGNORE = ['/node_modules/', '/@vite/', '/@feel-dev/', '/@react-refresh', '/@id/'];

const traceMaps = new WeakMap(); // sourcemap object → TraceMap

// Libraries that call into *everyone's* code — not worth pointing out.
const BORING_LIBS = /^(react|react-dom|scheduler|next)(\/|$)/;

// locate(raw, line, column, context) → where a frame really is:
//   { file, line, column }   your code (absolute file, original position)
//   { lib: 'axios' }         a library (lib may be null when it can't be named)
//   null                     unknown — skipped
// Vite's is viteFrameLocator below; Next's lives in @feel-dev/next.
//
// Returns your frames, innermost first. Where a library sits between your
// frames — or called your outermost one — a marker is inserted:
//   [fetchSales, { lib: '@tanstack/react-query' }, onSuccess (NewOrderButton), …]
// so the panel can show "NewOrderButton ⇢ @tanstack/react-query ⇢ fetchSales".
export async function resolveStack(stack, { locate, display, context }) {
  const frames = [];
  let pendingLib = null; // library seen since the last frame of yours

  for (const text of String(stack).split('\n')) {
    const match = text.match(FRAME);
    if (!match) continue;
    const loc = await locate(match[1], Number(match[2]), Number(match[3]), context).catch(() => null);
    if (!loc) continue;

    if ('lib' in loc || isLibraryFile(loc.file)) {
      // Only libraries *outside* your code count (not axios inside fetchSales).
      const lib = frames.length && !pendingLib ? ('lib' in loc ? loc.lib : libraryName(loc.file.replace(/\\/g, '/'))) : null;
      if (lib && !BORING_LIBS.test(lib) && !lib.startsWith('@feel-dev/')) pendingLib = lib;
      continue;
    }

    const { line, column } = loc;
    const loaded = await loadFile(loc.file).catch(() => null);
    const fnPath = loaded?.ast && functionAtLine(loaded.ast, line);
    const named = fnPath && findNamedFunction(fnPath);
    const component = fnPath && findComponent(fnPath);

    if (pendingLib) {
      frames.push({ lib: pendingLib });
      pendingLib = null;
    }
    frames.push({
      file: display(loc.file),
      line,
      column,
      fn: named ? functionName(named) : null, // innermost named, e.g. "load"
      top: fnPath ? topLevelName(fnPath) : null, // its top-level function, e.g. "useApi"
      component: component ? functionName(component) : null,
    });
  }

  if (pendingLib) frames.push({ lib: pendingLib });
  return frames;
}

// Vite: the browser runs modules Vite served, one URL per file.
// getModule(url) → { file, map } from Vite's module graph.
export function viteFrameLocator(getModule) {
  return async (raw, line, column) => {
    if (!/^https?:/.test(raw)) return null;
    const url = new URL(raw);
    if (IGNORE.some((part) => url.pathname.includes(part))) return { lib: libraryName(url.pathname) };

    url.searchParams.delete('t'); // HMR timestamp
    const mod = await getModule(url.pathname + url.search);
    if (!mod?.file) return null;

    if (mod.map?.mappings) {
      let tm = traceMaps.get(mod.map);
      if (!tm) traceMaps.set(mod.map, (tm = new TraceMap(mod.map)));
      const pos = originalPositionFor(tm, { line, column: column - 1 });
      if (pos.line != null) return { file: mod.file, line: pos.line, column: pos.column + 1 };
    }
    return { file: mod.file, line, column };
  };
}

const isLibraryFile = (file) => /[\\/]node_modules[\\/]/.test(file);

// URL path of a library module → package name.
//   /node_modules/.vite/deps/@tanstack_react-query.js  → @tanstack/react-query
//   /node_modules/.vite/deps/react-dom_client.js       → react-dom/client
//   /node_modules/axios/lib/core/Axios.js              → axios
//   /node_modules/.pnpm/axios@1.7.0/node_modules/axios/… → axios (the last one counts)
// Vite's shared "chunk-XXXX.js" files don't say which package they are → null.
export function libraryName(pathname) {
  const deps = pathname.match(/\/\.vite\/deps\/([^/?]+)\.js$/);
  if (deps) return deps[1].startsWith('chunk-') ? null : deps[1].replace('_', '/');
  const direct = [...pathname.matchAll(/\/node_modules\/((?:@[^/]+\/)?[^/]+)/g)].at(-1);
  return direct?.[1] ?? null;
}

// The outermost function around a path — the one declared at the top of the
// file. `const load = () => …` inside useApi → "useApi". This is what the
// static call graph knows about, so it's what we match on.
function topLevelName(fnPath) {
  let outer = fnPath;
  while (outer.getFunctionParent()) outer = outer.getFunctionParent();
  return functionName(outer);
}
