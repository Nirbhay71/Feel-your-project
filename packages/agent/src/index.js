// The Node-side "agent", mounted inside the Vite dev server at /__feel
// (createAgent), or served by a Next.js route handler (createAgentHandler,
// wired up by @feel-dev/next).
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
import { resolveStack, viteFrameLocator } from './stack.js';
import { resolveHandler } from './handler.js';
import { tablesInSql } from './sql.js';
import { createDb } from './db.js';
import { possibleCalls } from './static.js';
import { setViteAliases } from './resolve.js';

export { parseCode, traverse, findComponent, functionName, findTopLevelFunction, boundNames } from './ast.js';
export { resolveImport } from './resolve.js';
export { tagJsx } from './transform.js';
export { nextRouteInfo } from './next-routes.js';
export { viteFrameLocator, libraryName } from './stack.js';

export const AGENT_ROUTE = '/__feel';

// Only these files can ever be read — never .env, keys, etc.
const SOURCE_FILE = /\.(jsx?|tsx?|mjs|cjs)$/;
// Build output is generated code (and may hold inlined secrets): never read.
const BUILD_DIRS = new Set(['.next', 'dist', 'build', '.vite', 'coverage', '.svelte-kit', '.turbo']);

const LANGUAGES = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript' };

const MYSQL_URL = /^(mysql2?|mariadb):\/\//i;
const MYSQL_TABLE_VIEW =
  'Table view is Postgres-only for now — feel({ database }) got a MySQL URL. MySQL queries and tables still show per request.';

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
// locateFrame: instead of getModule — (rawUrl, line, col, { origin }) →
//              { file, line, column } | { lib } | null (see stack.js)
// database:    optional Postgres connection string (for /db/*). A MySQL URL
//              is accepted, but the table view is Postgres-only for now.
// aliases:     Vite's resolved resolve.alias, so '@/…' imports can be followed
// editorUrl:   (absPath, line) → URL that opens the file in the editor
//
// Returns { handle(req) } — req is a plain description of the request:
//   { method, pathname, searchParams, headers (lower-case keys), readBody() → string, origin }
// and handle() resolves to { status, body }, or null for "not ours".
export function createAgentHandler({ root, projectRoot, getModule, locateFrame, database, aliases, editorUrl = viteEditorUrl }) {
  const rootDir = path.resolve(root);
  const projectDir = projectRoot ? path.resolve(projectRoot) : findProjectRoot(rootDir);
  setViteAliases(aliases, rootDir);
  // MySQL queries and tables still show per request (they come from
  // @feel-dev/node); only the table view below needs Postgres. Never hand a
  // MySQL URL to pg — it would try to connect.
  const isMysql = typeof database === 'string' && MYSQL_URL.test(database);
  const db = database && !isMysql ? createDb(database) : null;
  const requireDb = () => {
    if (isMysql) throw new HttpError(501, MYSQL_TABLE_VIEW);
    if (!db) throw new HttpError(503, 'No database configured — pass feel({ database: url })');
    return db;
  };

  // Paths shown to the user: relative to Vite's root (like the data-src tags),
  // forward slashes. Backend files next to it come out as "../server/…".
  const display = (abs) => path.relative(rootDir, abs).split(path.sep).join('/');
  const locate = locateFrame ?? viteFrameLocator(getModule);

  // Security: resolve the path and refuse anything outside the project
  // (e.g. file=../../Windows/win.ini) or anything that isn't source code.
  const safePath = (file) => {
    if (!file) throw new HttpError(400, 'Missing ?file=');
    const abs = path.resolve(rootDir, file);
    const inBuild = path.relative(projectDir, abs).split(path.sep).some((part) => BUILD_DIRS.has(part));
    if (!abs.startsWith(projectDir + path.sep) || !SOURCE_FILE.test(abs) || abs.includes(`${path.sep}node_modules${path.sep}`) || inBuild) {
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
        openUrl: editorUrl(abs, line),
        language: LANGUAGES[path.extname(abs).slice(1)],
        code: loaded.code,
        name: range?.name ?? null,
        startLine: range?.startLine ?? line,
        endLine: range?.endLine ?? line,
        highlightLine: line,
      };
    },

    async 'POST /stack'(q, body, req) {
      return { frames: await resolveStack(body.stack ?? '', { locate, display, context: { origin: req.origin } }) };
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
      // The panel asks after every write — answer "no tracked changes"
      // quietly instead of an error each time.
      if (isMysql) return { audit: false, changes: [] };
      return requireDb().changesForRequest(request);
    },

    async 'POST /db/audit'() {
      return requireDb().enableAudit();
    },
  };

  async function handle(req) {
    const route = routes[`${req.method} ${req.pathname}`];
    if (!route) return null;

    // Only the page served by this dev server may use the agent. Another site
    // open in the same browser can't read our responses (no CORS), but it
    // could still *send* a POST — e.g. one that installs audit triggers.
    //  - a browser always sends Origin on cross-site requests: it must be us
    //  - …and Sec-Fetch-Site on every request: "cross-site" is never us,
    //    even where some browser leaves Origin out (a plain GET)
    //  - POSTs need the X-Feel header, which a cross-site page can't add
    //    without a CORS preflight that we never approve
    const origin = req.headers.origin;
    if (origin && hostOf(origin) !== req.headers.host) return { status: 403, body: { error: 'Cross-origin request refused' } };
    if (req.headers['sec-fetch-site'] === 'cross-site') return { status: 403, body: { error: 'Cross-site request refused' } };
    if (req.method === 'POST' && req.headers['x-feel'] !== '1') return { status: 403, body: { error: 'Missing X-Feel header' } };

    try {
      const body = req.method === 'POST' ? parseJson(await req.readBody()) : null;
      return { status: 200, body: await route(req.searchParams, body, req) };
    } catch (err) {
      return { status: err.status ?? 500, body: { error: err.message } };
    }
  }

  return { handle };
}

// Connect/Express-style middleware for Vite. Vite strips the /__feel prefix
// from req.url. Options: see createAgentHandler.
export function createAgent(options) {
  const { handle } = createAgentHandler(options);
  return async (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    const result = await handle({
      method: req.method,
      pathname: url.pathname,
      searchParams: url.searchParams,
      headers: req.headers,
      readBody: () => readRaw(req),
      origin: `http://${req.headers.host}`,
    });
    if (!result) return next();
    send(res, result.status, result.body);
  };
}

// Vite's dev server has a built-in /__open-in-editor endpoint.
const viteEditorUrl = (abs, line) => `/__open-in-editor?file=${encodeURIComponent(`${abs}:${line}`)}`;

// "http://localhost:5173" → "localhost:5173"; garbage → never equal to a Host.
function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
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

async function readRaw(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

function parseJson(raw) {
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
