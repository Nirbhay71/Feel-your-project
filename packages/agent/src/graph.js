// Static call graph: which functions can a component reach?
//
//   SalesChart ─uses→ useApi (hooks/useApi.js)
//              └uses→ fetchSales (api.js) ─uses→ getJson (api.js)
//
// → functions: ["src/components/SalesChart.jsx#SalesChart", "src/hooks/useApi.js#useApi",
//               "src/api.js#fetchSales", "src/api.js#getJson"]
//   direct:    ["src/hooks/useApi.js#useApi", "src/api.js#fetchSales"]   (called by SalesChart itself)
//
// The panel uses this to decide which API calls belong to a component when
// the component itself isn't on the stack (e.g. the fetch ran inside a
// custom hook's useEffect).

import { functionName, findTopLevelFunction } from './ast.js';
import { loadFile, importTarget } from './files.js';

const MAX_DEPTH = 5;

export async function reachableFunctions(abs, name, display) {
  const functions = new Set();
  const resolved = new Map(); // "file#requestedName" → display key ("default" → real name)
  let rootTargets = [];

  async function visit(file, fnName, depth) {
    const key = `${file}#${fnName}`;
    if (resolved.has(key)) return;
    resolved.set(key, null);

    const loaded = await loadFile(file).catch(() => null);
    if (!loaded?.ast) return;
    const fn = findTopLevelFunction(loaded.ast, fnName);
    if (!fn) return; // not a function (e.g. a data constant) — ignore

    const displayKey = `${display(file)}#${functionName(fn) ?? fnName}`;
    resolved.set(key, displayKey);
    functions.add(displayKey);
    if (depth === 0) return;

    // Every identifier used inside this function that points to another
    // function: either imported, or declared at the top of this file.
    const targets = [];
    fn.traverse({
      Identifier(p) {
        if (!p.isReferencedIdentifier()) return;
        const binding = p.scope.getBinding(p.node.name);
        if (!binding) return;
        if (binding.kind === 'module') {
          const target = importTarget(binding, file);
          if (target) targets.push(target);
        } else if (binding.scope.path.isProgram()) {
          targets.push({ file, name: p.node.name });
        }
      },
    });
    if (depth === MAX_DEPTH) rootTargets = targets;

    for (const t of targets) await visit(t.file, t.name, depth - 1);
  }

  await visit(abs, name, MAX_DEPTH);

  const direct = rootTargets.map((t) => resolved.get(`${t.file}#${t.name}`)).filter(Boolean);
  return { functions: [...functions], direct };
}
