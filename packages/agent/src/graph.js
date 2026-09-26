// Static call graph: which functions can a component reach?
//
//   SalesChart ─uses→ useApi (hooks/useApi.js)
//              └uses→ fetchSales (api.js) ─uses→ getJson (api.js)
//
// → ["src/components/SalesChart.jsx#SalesChart", "src/hooks/useApi.js#useApi",
//    "src/api.js#fetchSales", "src/api.js#getJson"]
//
// The panel uses this to decide which API calls belong to a component when
// the component itself isn't on the stack (e.g. the fetch ran inside a
// custom hook's useEffect).

import { functionName, findTopLevelFunction } from './ast.js';
import { loadFile, importTarget } from './files.js';

const MAX_DEPTH = 5;

export async function reachableFunctions(abs, name, display) {
  const out = new Set();
  const seen = new Set();

  async function visit(file, fnName, depth) {
    const key = `${file}#${fnName}`;
    if (seen.has(key)) return;
    seen.add(key);

    const loaded = await loadFile(file).catch(() => null);
    if (!loaded?.ast) return;
    const fn = findTopLevelFunction(loaded.ast, fnName);
    if (!fn) return; // not a function (e.g. a data constant) — ignore

    out.add(`${display(file)}#${functionName(fn) ?? fnName}`);
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

    for (const t of targets) await visit(t.file, t.name, depth - 1);
  }

  await visit(abs, name, MAX_DEPTH);
  return [...out];
}
