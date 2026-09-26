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
// custom hook's useEffect). static.js uses collectFunctions() to look for
// fetch() calls and SQL queries along the same graph.

import { functionName, findTopLevelFunction } from './ast.js';
import { loadFile, importTarget } from './files.js';

const MAX_DEPTH = 5;

export async function reachableFunctions(abs, name, display) {
  const loaded = await loadFile(abs).catch(() => null);
  const fn = loaded?.ast && findTopLevelFunction(loaded.ast, name);
  if (!fn) return { functions: [], direct: [] };

  const nodes = await collectFunctions(abs, fn);
  const key = (n) => `${display(n.file)}#${n.name}`;
  return {
    functions: nodes.map(key),
    direct: nodes.filter((n) => n.parent === nodes[0]).map(key),
  };
}

// Breadth-first walk from one function through every function it references,
// following imports. Returns [{ file, fn, name, parent }] — `parent` is the
// function it was first reached from, so a path back to the start can be
// rebuilt (shortest path, since it's breadth-first).
// `fn` can be any function path, including an inline one like
// router.get('/x', (req, res) => …).
export async function collectFunctions(file, fn, maxDepth = MAX_DEPTH) {
  const root = { file, fn, name: functionName(fn) ?? '(inline)', parent: null };
  const nodes = [root];
  const seen = new Set([`${file}#${root.name}`]);
  const queue = [[root, maxDepth]];

  while (queue.length) {
    const [node, depth] = queue.shift();
    if (depth === 0) continue;
    for (const t of referencedFunctions(node.fn, node.file)) {
      const loaded = await loadFile(t.file).catch(() => null);
      const target = loaded?.ast && findTopLevelFunction(loaded.ast, t.name);
      if (!target) continue; // not a function (e.g. a data constant) — ignore
      const name = functionName(target) ?? t.name;
      const key = `${t.file}#${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const child = { file: t.file, fn: target, name, parent: node };
      nodes.push(child);
      queue.push([child, depth - 1]);
    }
  }
  return nodes;
}

// Every identifier used inside a function that could point to another
// function: either imported, or declared at the top of the same file.
// Returns [{ file, name }] ("default" for default imports).
export function referencedFunctions(fn, file) {
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
  return targets;
}
