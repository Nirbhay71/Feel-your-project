// Piece 3 — the Node-side "agent".
//
// GET /__feel/source?file=src/components/SalesChart.jsx&line=14
//   → {
//       file, absPath, component, language,
//       code,            full file contents
//       startLine,       first line of the component (incl. "export default")
//       endLine,         last line of the component
//       highlightLine    the line that rendered the clicked element
//     }
//
// For now it's mounted inside the Vite dev server (see vite-plugin).
// Later layers (backend, database) will add more handlers here.

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseCode, traverse, findComponent, functionName } from './ast.js';

export { parseCode, traverse, findComponent, functionName } from './ast.js';

export const SOURCE_ROUTE = '/__feel/source';

// Only these files can ever be read — never .env, keys, etc.
const SOURCE_FILE = /\.(jsx?|tsx?|mjs|cjs)$/;

const LANGUAGES = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript' };

// Returns a connect/express-style middleware: (req, res, next).
export function createSourceHandler({ root }) {
  const rootDir = path.resolve(root);

  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = url.searchParams.get('file');
    const line = Number(url.searchParams.get('line'));

    if (!file || !Number.isInteger(line) || line < 1) {
      return send(res, 400, { error: 'Expected ?file=<path>&line=<number>' });
    }

    // Security: resolve the path and refuse anything outside the project
    // (e.g. file=../../Windows/win.ini) or anything that isn't source code.
    const abs = path.resolve(rootDir, file);
    if (!abs.startsWith(rootDir + path.sep) || !SOURCE_FILE.test(abs)) {
      return send(res, 403, { error: 'File is outside the project or not a source file' });
    }

    let code;
    try {
      code = await fs.readFile(abs, 'utf8');
    } catch {
      return send(res, 404, { error: `File not found: ${file}` });
    }

    const range = findComponentRange(code, abs, line);
    const ext = path.extname(abs).slice(1);

    send(res, 200, {
      file,
      absPath: abs, // used by "Open in editor"
      language: LANGUAGES[ext],
      code,
      component: range?.component ?? null,
      startLine: range?.startLine ?? line,
      endLine: range?.endLine ?? line,
      highlightLine: line,
    });
  };
}

// Find the component that contains `line` and return its line range.
// We look for the innermost function around that line, then climb to the
// nearest component function, then widen to its top-level statement so the
// range includes "export default" / "const X = memo(...)".
export function findComponentRange(code, file, line) {
  let ast;
  try {
    ast = parseCode(code, file);
  } catch {
    return null; // syntax error mid-edit — just highlight the line
  }

  let innermost = null;
  traverse(ast, {
    Function(p) {
      const { start, end } = p.node.loc;
      if (start.line <= line && line <= end.line) innermost = p; // deeper matches win
    },
  });
  if (!innermost) return null;

  const component = findComponent(innermost);
  if (!component) return null;

  const statement = component.find((p) => p.parentPath?.isProgram()) ?? component;
  return {
    component: functionName(component),
    startLine: statement.node.loc.start.line,
    endLine: statement.node.loc.end.line,
  };
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
