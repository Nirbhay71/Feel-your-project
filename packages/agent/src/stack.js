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

// getModule(url) → { file, map } from Vite's module graph.
export async function resolveStack(stack, { getModule, display }) {
  const frames = [];

  for (const text of String(stack).split('\n')) {
    const match = text.match(FRAME);
    if (!match) continue;
    const url = new URL(match[1]);
    if (IGNORE.some((part) => url.pathname.includes(part))) continue;

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

    frames.push({
      file: display(mod.file),
      line,
      column,
      fn: named ? functionName(named) : null,
      component: component ? functionName(component) : null,
    });
  }

  return frames;
}
