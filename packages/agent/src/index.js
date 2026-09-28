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
// GET  /__feel/possible?file=…&component=… → API calls it could make (static only)
// POST /__feel/sql      { sql }            → tables it reads/writes (Layer 3)
// GET  /__feel/db/table?name=…             → columns, keys, relations, recent changes
// GET  /__feel/db/changes?request=…        → rows changed by one request
// POST /__feel/db/audit                    → turn on change tracking (installs triggers)

import fs from 'node:fs';
import path from 'node:path';
import { functionAtLine, findComponent, findNamedFunction, functionName } from './ast.js';
import { loadFile } from './files.js';
import { reachableFunctions } from './graph.js';
import { resolveStack } from './stack.js';
import { resolveHandler } from './handler.js';
import { tablesInSql } from './sql.js';
import { createDb } from './db.js';
import { possibleCalls } from './static.js';
import { setViteAliases } from './resolve.js';

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

// root:        Vite's root (usually the frontend folder)
// projectRoot: the whole project — frontend *and* backend. Nothing outside it
//              is ever read. Default: the nearest folder above `root` with a
//              .git, so client/ + server/ side by side both work.
// getModule:   url → { file, map } from Vite's module graph (for /stack)
// database:    optional Postgres connection string (for /db/*)
// aliases:     Vite's resolved resolve.alias, so '@/…' imports can be followed
export function createAgent({ root, projectRoot, getModule, database, aliases }) {
  const rootDir = path.resolve(root);
  const projectDir = projectRoot ? path.resolve(projectRoot) : findProjectRoot(rootDir);
  setViteAliases(aliases, rootDir);
  const db = database ? createDb(database) : null;
  const requireDb = () => {
    if (!db) throw new HttpError(503, 'No database configured — pass feel({ database: url })');
    return db;
  };

  // Paths shown to the user: relative to Vite's root (like the data-src tags),
  // forward slashes. Backend files next to it come out as "../server/…".
  const display = (abs) => path.relative(rootDir, abs).split(path.sep).join('/');

  // Security: resolve the path and refuse anything outside the project
  // (e.g. file=../../Windows/win.ini) or anything that isn't source code.
  const safePath = (file) => {
    if (!file) throw new HttpError(400, 'Missing ?file=');
    const abs = path.resolve(rootDir, file);
    if (!abs.startsWith(projectDir + path.sep) || !SOURCE_FILE.test(abs) || abs.includes(`${path.sep}node_modules${path.sep}`)) {
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

    async 'GET /possible'(q) {
      const abs = safePath(q.get('file'));
      const component = q.get('component');
      if (!component) throw new HttpError(400, 'Missing ?component=');
      // Scan the whole project for backend routes, not just the frontend folder.
      return { calls: await possibleCalls({ abs, component, rootDir: projectDir, display }) };
    },

    async 'POST /sql'(q, body) {
      return { tables: tablesInSql(String(body.sql ?? '')) };
    },

    async 'GET /db/table'(q) {
      const table = await requireDb().getTable(q.get('name') ?? '');
      if (!table) throw new HttpError(404, `No table "${q.get('name')}" in the database`);
      return table;
    },

    async 'GET /db/changes'(q) {
      const request = q.get('request');
      if (!request) throw new HttpError(400, 'Missing ?request=');
      return requireDb().changesForRequest(request);
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

    // Only the page served by this dev server may use the agent. Another site
    // open in the same browser can't read our responses (no CORS), but it
    // could still *send* a POST — e.g. one that installs audit triggers.
    //  - a browser always sends Origin on cross-site requests: it must be us
    //  - POSTs need the X-Feel header, which a cross-site page can't add
    //    without a CORS preflight that we never approve
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Cross-origin request refused' });
    if (req.method === 'POST' && req.headers['x-feel'] !== '1') return send(res, 403, { error: 'Missing X-Feel header' });

    try {
      const body = req.method === 'POST' ? await readJson(req) : null;
      send(res, 200, await route(url.searchParams, body));
    } catch (err) {
      send(res, err.status ?? 500, { error: err.message });
    }
  };
}

// The nearest folder at or above `dir` that holds a .git (file or folder);
// `dir` itself if there's none.
function findProjectRoot(dir) {
  for (let cur = dir; ; cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    if (path.dirname(cur) === cur) return dir;
  }
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
