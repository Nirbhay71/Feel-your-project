// The Node-side "agent", mounted inside the Vite dev server at /__feel.
//
// GET  /__feel/source?file=…&line=…
//        → the file's code + the range of the function/component around that line
// GET  /__feel/source?file=…&line=…&resolve=handler&index=0
//        → same, but first follows a route registration to its handler (Layer 2)
// POST /__feel/stack   { stack }
//        → browser stack trace mapped to original file/line/function/component
// GET  /__feel/reach?file=…&component=…
//        → every function that component can reach (static call graph)
// POST /__feel/sql      { sql }            → tables it reads/writes (Layer 3)
// GET  /__feel/db/table?name=…             → columns, keys, relations, recent changes
// POST /__feel/db/audit                    → turn on change tracking (installs triggers)

import path from 'node:path';
import { functionAtLine, findComponent, findNamedFunction, functionName } from './ast.js';
import { loadFile } from './files.js';
import { reachableFunctions } from './graph.js';
import { resolveStack } from './stack.js';
import { resolveHandler } from './handler.js';
import { tablesInSql } from './sql.js';
import { createDb } from './db.js';

export { parseCode, traverse, findComponent, functionName } from './ast.js';

export const AGENT_ROUTE = '/__feel';

// Only these files can ever be read — never .env, keys, etc.
const SOURCE_FILE = /\.(jsx?|tsx?|mjs|cjs)$/;

const LANGUAGES = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// root:      project folder; nothing outside it is ever read
// getModule: url → { file, map } from Vite's module graph (for /stack)
// database:  optional Postgres connection string (for /db/*)
export function createAgent({ root, getModule, database }) {
  const rootDir = path.resolve(root);
  const db = database ? createDb(database) : null;
  const requireDb = () => {
    if (!db) throw new HttpError(503, 'No database configured — pass feel({ database: url })');
    return db;
  };

  // Paths shown to the user: relative to the root, forward slashes.
  const display = (abs) => path.relative(rootDir, abs).split(path.sep).join('/');

  // Security: resolve the path and refuse anything outside the project
  // (e.g. file=../../Windows/win.ini) or anything that isn't source code.
  const safePath = (file) => {
    if (!file) throw new HttpError(400, 'Missing ?file=');
    const abs = path.resolve(rootDir, file);
    if (!abs.startsWith(rootDir + path.sep) || !SOURCE_FILE.test(abs)) {
      throw new HttpError(403, 'File is outside the project or not a source file');
    }
    return abs;
  };

  const routes = {
    async 'GET /source'(q) {
      let abs = safePath(q.get('file'));
      let line = Number(q.get('line'));
      if (!Number.isInteger(line) || line < 1) throw new HttpError(400, 'Expected ?line=<number>');

      if (q.get('resolve') === 'handler') {
        const target = await resolveHandler(abs, line, Number(q.get('index') ?? 0)).catch(() => null);
        if (target) {
          abs = safePath(target.file);
          line = target.line;
        }
      }

      const loaded = await loadFile(abs).catch(() => null);
      if (!loaded) throw new HttpError(404, `File not found: ${display(abs)}`);

      const range = findRange(loaded.ast, line);
      return {
        file: display(abs),
        absPath: abs, // used by "Open in editor"
        language: LANGUAGES[path.extname(abs).slice(1)],
        code: loaded.code,
        name: range?.name ?? null,
        startLine: range?.startLine ?? line,
        endLine: range?.endLine ?? line,
        highlightLine: line,
      };
    },

    async 'POST /stack'(q, body) {
      return { frames: await resolveStack(body.stack ?? '', { getModule, display }) };
    },

    async 'GET /reach'(q) {
      const abs = safePath(q.get('file'));
      const component = q.get('component');
      if (!component) throw new HttpError(400, 'Missing ?component=');
      return reachableFunctions(abs, component, display);
    },

    async 'POST /sql'(q, body) {
      return { tables: tablesInSql(String(body.sql ?? '')) };
    },

    async 'GET /db/table'(q) {
      const table = await requireDb().getTable(q.get('name') ?? '');
      if (!table) throw new HttpError(404, `No table "${q.get('name')}" in the database`);
      return table;
    },

    async 'POST /db/audit'() {
      return requireDb().enableAudit();
    },
  };

  // Connect/Express-style middleware. Vite strips the /__feel prefix from req.url.
  return async (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return next();

    try {
      const body = req.method === 'POST' ? await readJson(req) : null;
      send(res, 200, await route(url.searchParams, body));
    } catch (err) {
      send(res, err.status ?? 500, { error: err.message });
    }
  };
}

// The range to show around `line`: the component if there is one,
// otherwise the named function (e.g. a route handler), widened to its
// top-level statement so "export default" / "router.get(…)" is included.
function findRange(ast, line) {
  const fn = ast && functionAtLine(ast, line);
  if (!fn) return null;

  const target = findComponent(fn) ?? findNamedFunction(fn) ?? fn;
  const statement = target.find((p) => p.parentPath?.isProgram()) ?? target;
  return {
    name: functionName(target),
    startLine: statement.node.loc.start.line,
    endLine: statement.node.loc.end.line,
  };
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
