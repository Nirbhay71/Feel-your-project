// Turn a browser stack trace into original source locations.
//
// The browser runs code that Vite has transformed, so a stack line like
//   at fetchSales (http://localhost:5173/src/api.js?t=172:8:34)
// points into the *transformed* file. Vite keeps a sourcemap for every module
// it served; we use it to map back to the line you actually wrote, then look
// up which function and component that line belongs to.

import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { functionAtLine, findNamedFunction, findComponent, functionName } from './ast.js';
import { loadFile } from './files.js';

// Matches the "url:line:col" at the end of a Chrome or Firefox stack line.
const FRAME = /(https?:\/\/[^\s()]+?):(\d+):(\d+)\)?\s*$/;

// Frames from these URLs are libraries or our own tooling — skip them.
const IGNORE = ['/node_modules/', '/@vite/', '/@feel/', '/@react-refresh', '/@id/'];

const traceMaps = new WeakMap(); // sourcemap object → TraceMap

// Libraries that call into *everyone's* code — not worth pointing out.
const BORING_LIBS = /^(react|react-dom|scheduler)(\/|$)/;

// getModule(url) → { file, map } from Vite's module graph.
//
// Returns your frames, innermost first. Where a library sits between your
// frames — or called your outermost one — a marker is inserted:
//   [fetchSales, { lib: '@tanstack/react-query' }, onSuccess (NewOrderButton), …]
// so the panel can show "NewOrderButton ⇢ @tanstack/react-query ⇢ fetchSales".
export async function resolveStack(stack, { getModule, display }) {
  const frames = [];
  let pendingLib = null; // library seen since the last frame of yours

  for (const text of String(stack).split('\n')) {
    const match = text.match(FRAME);
    if (!match) continue;
    const url = new URL(match[1]);
    if (IGNORE.some((part) => url.pathname.includes(part))) {
      // Only libraries *outside* your code count (not axios inside fetchSales).
      const lib = frames.length && !pendingLib ? libraryName(url.pathname) : null;
      if (lib && !BORING_LIBS.test(lib)) pendingLib = lib;
      continue;
    }

    url.searchParams.delete('t'); // HMR timestamp
    const mod = await getModule(url.pathname + url.search);
    if (!mod?.file) continue;

    let line = Number(match[2]);
    let column = Number(match[3]);
    if (mod.map?.mappings) {
      let tm = traceMaps.get(mod.map);
      if (!tm) traceMaps.set(mod.map, (tm = new TraceMap(mod.map)));
      const pos = originalPositionFor(tm, { line, column: column - 1 });
      if (pos.line != null) {
        line = pos.line;
        column = pos.column + 1;
      }
    }

    const loaded = await loadFile(mod.file).catch(() => null);
    const fnPath = loaded?.ast && functionAtLine(loaded.ast, line);
    const named = fnPath && findNamedFunction(fnPath);
    const component = fnPath && findComponent(fnPath);

    if (pendingLib) {
      frames.push({ lib: pendingLib });
      pendingLib = null;
    }
    frames.push({
      file: display(mod.file),
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

// URL path of a library module → package name.
//   /node_modules/.vite/deps/@tanstack_react-query.js  → @tanstack/react-query
//   /node_modules/.vite/deps/react-dom_client.js       → react-dom/client
//   /node_modules/axios/lib/core/Axios.js              → axios
// Vite's shared "chunk-XXXX.js" files don't say which package they are → null.
function libraryName(pathname) {
  const deps = pathname.match(/\/\.vite\/deps\/([^/?]+)\.js$/);
  if (deps) return deps[1].startsWith('chunk-') ? null : deps[1].replace('_', '/');
  const direct = pathname.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)/);
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
