// Static "possible calls": every API call a component *could* make, found by
// reading code only — including ones behind buttons nobody has clicked yet.
//
//   NewOrderButton ─→ placeOrder ─→ getJson ─→ fetch(url, options)
//                     └ getJson('/api/orders', { method: 'POST' })
//   → POST /api/orders
//   → server/routes/orders.js:7   router.post('/orders', …)   (mounted at /api)
//   → services/orders.js:6        pool.query('INSERT INTO orders …')  → orders ✎, users, products
//
// Steps:
//   1. frontendCalls: walk the component's call graph, find fetch()/axios
//      calls, and work out method + URL — following parameters back to the
//      callers that pass literals (getJson(url) ← fetchSales: getJson('/api/sales')).
//   2. backendRoutes: scan the project for Express routes and app.use()
//      mounts to get each route's full path.
//   3. matchRoute: URL pattern ↔ route path (":id" and "*" are wildcards).
//   4. routeQueries: walk the handler's call graph for pool.query('…') /
//      pool.execute('…') SQL and Prisma / Drizzle calls (orm.js).

import fs from 'node:fs';
import path from 'node:path';
import { traverse, functionName, findTopLevelFunction, functionAtLine, findNamedFunction } from './ast.js';
import { loadFile, importTarget, refTarget, resolveImport } from './files.js';
import { collectFunctions } from './graph.js';
import { resolveHandler } from './handler.js';
import { tablesInSql } from './sql.js';
import { ormQuery } from './orm.js';

export async function possibleCalls({ abs, component, rootDir, display }) {
  const loaded = await loadFile(abs).catch(() => null);
  const fn = loaded?.ast && findTopLevelFunction(loaded.ast, component);
  if (!fn) return [];

  const nodes = await collectFunctions(abs, fn);
  const calls = await frontendCalls(nodes);
  const routes = await backendRoutes(rootDir);

  const out = [];
  const seen = new Set();
  for (const call of calls) {
    const key = `${call.method} ${call.url} ${call.site.file}:${call.site.line}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const route = matchRoute(call, routes);
    out.push({
      method: call.method,
      url: call.url,
      // Component → … → the function that holds the URL (→ the one that calls fetch)
      chain: chainTo(call.siteNode, call.sinkNode, call.inner).map((n) => ({
        fn: n.name,
        file: display(n.file),
        line: n.fn.node.loc.start.line,
      })),
      site: { file: display(call.site.file), line: call.site.line },
      route: route && (await describeRoute(route, rootDir)),
    });
  }
  return out;
}

// --- 1. Frontend ------------------------------------------------------------

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// Values we can figure out statically:
//   { str: '/api/users/*' }       a string (unknown parts become *)
//   { param: 0 }                  "whatever the caller passes as argument 0"
//   { param: 1, options: true }   (method) "the `method` of the options object passed as argument 1"
//   null                          unknown
async function frontendCalls(nodes) {
  const results = [];

  // Pending: fetch() calls whose URL/method depend on a parameter of the
  // function they're in. Resolved by looking at that function's callers.
  let pending = [];

  // Calls made *for* you by a library: useSWR(key, fetcher) means SWR will
  // call fetcher(key). Recorded as { target, args, siteNode, line, inner }
  // and treated like a real call when resolving parameters below.
  const virtualCalls = [];

  const scan = async (node) => {
    // Collect first (traverse is synchronous), then check each call — axios
    // instances may need another file loaded.
    const calls = [];
    node.fn.traverse({
      CallExpression(p) {
        calls.push(p);
      },
    });
    for (const p of calls) {
      const line = p.node.loc.start.line;
      const swr = swrCall(p, node.fn);
      if (swr) {
        const target = swr.fetcher && resolveFetcher(swr.fetcher, node, nodes);
        if (target) {
          virtualCalls.push({ target, args: swr.key, siteNode: node, line, inner: innerName(p, node) });
          if (target.inline) await scan(target); // its fetch() needs the inline fetcher as the "top" function
        } else if (swr.key[0]?.str && !swr.fetcher) {
          // No fetcher: a global one from <SWRConfig> — assume a GET of the key.
          pending.push({ url: swr.key[0], method: 'GET', base: '', fnNode: node, sinkNode: node, siteNode: node, line, inner: innerName(p, node) });
        }
        continue;
      }
      const sink = fetchSink(p, node.fn) ?? (await axiosInstanceSink(p, node));
      if (!sink) continue;
      pending.push({ url: sink.url, method: sink.method, base: sink.base ?? '', fnNode: node, sinkNode: node, siteNode: node, line, inner: innerName(p, node) });
    }
  };
  for (const node of nodes) await scan(node);

  // Resolve parameters up to 3 levels of wrappers: getJson(url) → fetchSales.
  for (let level = 0; level < 4 && pending.length; level++) {
    const next = [];
    for (const item of pending) {
      const urlDone = item.url?.str != null;
      const methodDone = typeof item.method === 'string';
      if (urlDone && methodDone) {
        results.push({ method: item.method, url: joinUrl(item.base, item.url.str), site: { file: item.siteNode.file, line: item.line }, siteNode: item.siteNode, sinkNode: item.sinkNode, inner: item.inner });
        continue;
      }
      if (!item.url) continue; // URL can't be known statically

      // Look for calls to item.fnNode in every reachable function.
      for (const caller of nodes) {
        caller.fn.traverse({
          CallExpression(p) {
            if (!callsFunction(p, caller.file, item.fnNode)) return;
            const args = p.get('arguments');
            const url = item.url.param != null ? evalString(args[item.url.param], caller.fn) : item.url;
            const method = typeof item.method === 'string' ? item.method : methodFromArg(args[item.method.param], item.method.options, caller.fn);
            next.push({ url, method: method ?? 'GET', base: item.base, fnNode: caller, sinkNode: item.sinkNode, siteNode: caller, line: p.node.loc.start.line, inner: innerName(p, caller) });
          },
        });
      }

      // …and calls a library makes on your behalf (SWR calling the fetcher).
      for (const v of virtualCalls) {
        if (v.target !== item.fnNode) continue;
        const url = item.url.param != null ? (v.args[item.url.param] ?? null) : item.url;
        const method = typeof item.method === 'string' ? item.method : 'GET';
        next.push({ url, method, base: item.base, fnNode: v.siteNode, sinkNode: item.sinkNode, siteNode: v.siteNode, line: v.line, inner: v.inner });
      }
    }
    pending = next;
  }
  return results;
}

// --- SWR ------------------------------------------------------------------------

// Which SWR hook does a default import from this module give you?
const SWR_DEFAULTS = { swr: 'useSWR', 'swr/immutable': 'useSWRImmutable', 'swr/mutation': 'useSWRMutation' };
const SWR_HOOKS = new Set(Object.values(SWR_DEFAULTS));

// useSWR(key, fetcher?, options?) / useSWRImmutable / useSWRMutation
// → { key: [values SWR passes to the fetcher], fetcher: path | null } or null.
function swrCall(p, topFn) {
  const callee = p.get('callee');
  if (!callee.isIdentifier()) return null;
  const binding = p.scope.getBinding(callee.node.name);
  const source = binding?.kind === 'module' ? binding.path.parent.source.value : null;
  if (!source || !/^swr(\/|$)/.test(source)) return null;
  const hook = binding.path.isImportDefaultSpecifier() ? SWR_DEFAULTS[source] : binding.path.node.imported?.name;
  if (!SWR_HOOKS.has(hook)) return null;

  const [keyArg, fetcherArg] = p.get('arguments');
  const key = swrKey(keyArg, topFn);
  if (!key) return null; // key can't be known statically
  const fetcher = fetcherArg?.isIdentifier() || fetcherArg?.isFunction() ? fetcherArg : null;
  return { key, fetcher };
}

// SWR keys → the arguments SWR calls the fetcher with.
//   '/api/x'                        → ['/api/x']
//   ['/api/x', id]                  → ['/api/x', *]      (fetcher(...key))
//   () => `/api/x/${id}`            → ['/api/x/*']
//   id ? `/api/x/${id}` : null      → ['/api/x/*']      (conditional fetching)
//   user && '/api/me'               → ['/api/me']
function swrKey(p, topFn) {
  if (!p?.node) return null;
  if (p.isArrayExpression()) return p.get('elements').map((e) => evalString(e, topFn));
  if (p.isArrowFunctionExpression() && !p.get('body').isBlockStatement()) return swrKey(p.get('body'), topFn);
  if (p.isConditionalExpression()) return swrKey(p.get('consequent'), topFn) ?? swrKey(p.get('alternate'), topFn);
  if (p.isLogicalExpression({ operator: '&&' })) return swrKey(p.get('right'), topFn);
  if (p.isNullLiteral()) return null;
  const value = evalString(p, topFn);
  return value ? [value] : null;
}

// The fetcher passed to useSWR, as a node the resolver understands:
//   useSWR(key, fetcher)            → the reachable node for `fetcher`
//   useSWR(key, (url) => fetch(url)) → a node for the inline function
//   const f = (url) => …; useSWR(key, f)   (declared inside the component) → same
function resolveFetcher(arg, node, nodes) {
  const inline = (fnPath) => ({ file: node.file, fn: fnPath, name: 'inline fetcher', parent: node, inline: true });
  if (arg.isFunction()) return inline(arg);

  const t = refTarget(arg, node.file); // imported, required or top-level
  if (t) return nodes.find((n) => n.file === t.file && (n.name === t.name || (t.name === 'default' && isDefaultExport(n.fn)))) ?? null;

  const binding = arg.scope.getBinding(arg.node.name);
  const init = binding?.path.isVariableDeclarator() ? binding.path.get('init') : null;
  return init?.isFunction() ? inline(init) : null;
}

const isDefaultExport = (fn) => fn.parentPath?.isExportDefaultDeclaration() || fn.parentPath?.isAssignmentExpression();

// fetch(url, options) / window.fetch / axios.get(url) / axios.post(url) /
// axios(url | { url, method }) / axios.request({ url, method })
function fetchSink(p, topFn) {
  const { callee } = p.node;
  const args = p.get('arguments');
  const member = callee.type === 'MemberExpression' ? callee : null;
  const objectName = member?.object.type === 'Identifier' ? member.object.name : null;
  const prop = member?.property.name;

  if ((callee.type === 'Identifier' && callee.name === 'fetch') || (objectName === 'window' && prop === 'fetch')) {
    return { url: evalString(args[0], topFn), method: methodFromArg(args[1], true, topFn) ?? 'GET' };
  }
  if (objectName === 'axios' && METHODS.includes(prop)) {
    return { url: evalString(args[0], topFn), method: prop.toUpperCase() };
  }
  const axiosConfig = (callee.type === 'Identifier' && callee.name === 'axios') || (objectName === 'axios' && prop === 'request');
  if (axiosConfig && args[0]?.isObjectExpression()) {
    return { url: evalString(propertyOf(args[0], 'url'), topFn), method: methodFromArg(args[0], true, topFn) ?? 'GET' };
  }
  if (axiosConfig) return { url: evalString(args[0], topFn), method: 'GET' };
  return null;
}

// Calls through an axios instance:
//   const api = axios.create({ baseURL: '/api' })     (here or imported)
//   api.get('/sales')   api.request({ url, method })   api({ url, method })
// → a sink like fetchSink's, plus `base` ('/api') to prefix the URL with.
async function axiosInstanceSink(p, node) {
  const callee = p.get('callee');
  let id = null;
  let method = null;
  if (callee.isMemberExpression() && callee.get('object').isIdentifier()) {
    id = callee.get('object');
    method = callee.node.property.name;
    if (!METHODS.includes(method) && method !== 'request') return null;
  } else if (callee.isIdentifier()) {
    id = callee;
  } else {
    return null;
  }
  if (id.node.name === 'axios' || id.node.name === 'fetch') return null; // fetchSink handles these

  const instance = await axiosInstance(id, node.file);
  if (!instance) return null;

  const args = p.get('arguments');
  if (METHODS.includes(method)) {
    return { url: evalString(args[0], node.fn), method: method.toUpperCase(), base: instance.base };
  }
  if (args[0]?.isObjectExpression()) {
    return { url: evalString(propertyOf(args[0], 'url'), node.fn), method: methodFromArg(args[0], true, node.fn) ?? 'GET', base: instance.base };
  }
  return { url: evalString(args[0], node.fn), method: 'GET', base: instance.base };
}

// Is this identifier an axios instance? → { base } or null. Cached per binding.
const instanceCache = new Map(); // "file#name" → Promise<{ base } | null>
async function axiosInstance(id, file) {
  const binding = id.scope.getBinding(id.node.name);
  if (!binding) return null;

  // import axios from 'axios' under another name counts as the default instance.
  if (binding.kind === 'module' && binding.path.parent.source.value === 'axios') return binding.path.isImportDefaultSpecifier() ? { base: '' } : null;

  const target = importTarget(binding, file); // imported or required from your own code
  if (target) {
    const key = `${target.file}#${target.name}`;
    if (!instanceCache.has(key)) {
      instanceCache.set(
        key,
        loadFile(target.file)
          .then(({ ast }) => (ast ? exportedInstance(ast, target.name) : null))
          .catch(() => null),
      );
    }
    return instanceCache.get(key);
  }
  return binding.path.isVariableDeclarator() ? instanceFromInit(binding.path.get('init')) : null;
}

// Find `name` (or the default export) in a file and check it's axios.create(...).
// "*" (a whole required module) means module.exports.
function exportedInstance(ast, name) {
  const isDefault = name === 'default' || name === '*';
  let result = null;
  let alias = null;
  traverse(ast, {
    ExportDefaultDeclaration(p) {
      if (!isDefault) return;
      const decl = p.get('declaration');
      if (decl.isIdentifier()) alias = decl.node.name; // export default api;
      else result = instanceFromInit(decl);
      p.stop();
    },
    AssignmentExpression(p) {
      const left = p.node.left;
      if (!isDefault || left.type !== 'MemberExpression' || left.object.name !== 'module' || left.property.name !== 'exports') return;
      const right = p.get('right');
      if (right.isIdentifier()) alias = right.node.name; // module.exports = api;
      else result = instanceFromInit(right);
      p.stop();
    },
    VariableDeclarator(p) {
      if (isDefault || p.node.id.name !== name || p.scope.parent) return; // top-level only
      result = instanceFromInit(p.get('init'));
      p.stop();
    },
  });
  return alias ? exportedInstance(ast, alias) : result;
}

// axios.create({ baseURL: '/api' }) → { base: '/api' }; anything else → null.
function instanceFromInit(init) {
  if (!init?.isCallExpression()) return null;
  const c = init.node.callee;
  if (c.type !== 'MemberExpression' || c.object.name !== 'axios' || c.property.name !== 'create') return null;
  const config = init.get('arguments')[0];
  const base = config?.isObjectExpression() ? evalString(propertyOf(config, 'baseURL'), null) : null;
  return { base: base?.str ?? '' };
}

// "/api" + "/sales" → "/api/sales". Absolute URLs ignore the base, like axios.
function joinUrl(base, url) {
  if (!base || /^https?:\/\//.test(url)) return url;
  return `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

// The method, from either an options object ({ method: 'POST' }) or a string.
function methodFromArg(arg, isOptions, topFn) {
  if (!arg) return null;
  if (isOptions && arg.isObjectExpression()) {
    const m = evalString(propertyOf(arg, 'method'), topFn);
    return m?.str ? m.str.toUpperCase() : null;
  }
  const param = paramIndex(arg, topFn);
  if (param != null) return { param, options: isOptions };
  const m = evalString(arg, topFn);
  return m?.str ? m.str.toUpperCase() : null;
}

function propertyOf(objectPath, key) {
  return objectPath.get('properties').find((p) => p.isObjectProperty() && (p.node.key.name ?? p.node.key.value) === key)?.get('value');
}

// Evaluate a URL-ish expression to { str } / { param } / null.
function evalString(p, topFn, depth = 0) {
  if (!p?.node || depth > 5) return null;
  if (p.isStringLiteral()) return { str: p.node.value };
  if (p.isTemplateLiteral()) {
    const parts = p.get('expressions').map((e) => evalString(e, topFn, depth + 1)?.str ?? '*');
    return { str: p.node.quasis.map((q, i) => q.value.cooked + (parts[i] ?? '')).join('') };
  }
  if (p.isBinaryExpression({ operator: '+' })) {
    const l = evalString(p.get('left'), topFn, depth + 1)?.str ?? '*';
    const r = evalString(p.get('right'), topFn, depth + 1)?.str ?? '*';
    return { str: l + r };
  }
  if (p.isIdentifier()) {
    const param = paramIndex(p, topFn);
    if (param != null) return { param };
    const binding = p.scope.getBinding(p.node.name);
    const init = binding?.kind === 'const' && binding.path.isVariableDeclarator() ? binding.path.get('init') : null;
    return init ? evalString(init, topFn, depth + 1) : null;
  }
  return null; // import.meta.env.X, function calls, … — unknown
}

// If p is a parameter of the top-level function, its index; else null.
function paramIndex(p, topFn) {
  if (!topFn || !p?.isIdentifier()) return null;
  const binding = p.scope.getBinding(p.node.name);
  if (binding?.kind !== 'param' || binding.scope.block !== topFn.node) return null;
  const i = topFn.node.params.indexOf(binding.path.node);
  return i >= 0 ? i : null;
}

// Does this call expression call `target` (a node from collectFunctions)?
// Handles getJson(…), api.getJson(…), ctrl.getJson(…) — local, imported or required.
function callsFunction(p, file, target) {
  const t = refTarget(p.get('callee'), file);
  if (!t || t.file !== target.file) return false;
  return t.name === target.name || (t.name === 'default' && isDefaultExport(target.fn));
}

// The named function *inside* a top-level function where a call sits, if it
// has its own name — e.g. `dismiss` or `handleClick` inside a component.
// Returns { name, fn } or null.
function innerName(p, node) {
  const fn = findNamedFunction(p);
  if (!fn || fn.node === node.fn.node) return null;
  const name = functionName(fn);
  return name && name !== node.name ? { name, fn } : null;
}

// Component → … → site [→ its inner function] (→ sink, if the fetch happens
// in a wrapper further down).
function chainTo(siteNode, sinkNode, inner) {
  const chain = [];
  for (let n = siteNode; n; n = n.parent) chain.unshift(n);
  if (inner) chain.push({ name: inner.name, file: siteNode.file, fn: inner.fn });
  if (sinkNode !== siteNode) chain.push(sinkNode);
  return chain;
}

// --- 2. Backend routes ----------------------------------------------------------

const ROUTE_METHODS = [...METHODS, 'all'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.vite', 'coverage', '.next']);
const SOURCE = /\.(jsx?|tsx?|mjs|cjs)$/;
const MAX_FILES = 3000;

// Rescanning on every click is wasteful — cache briefly, per project folder.
const routeCache = new Map(); // rootDir → { at, promise }

function backendRoutes(rootDir) {
  const hit = routeCache.get(rootDir);
  if (hit && Date.now() - hit.at < 3000) return hit.promise;
  const entry = { at: Date.now(), promise: scanRoutes(rootDir) };
  routeCache.set(rootDir, entry);
  return entry.promise;
}

async function scanRoutes(rootDir) {
  const routes = []; // { file, varName, method, path, line, handlerIndex }
  const mounts = []; // { file, varName, prefix, child: { file } | { file, varName } }
  const apps = new Set(); // "file#var" created with express()

  for (const file of listFiles(rootDir)) {
    const loaded = await loadFile(file).catch(() => null);
    if (!loaded?.ast || !/\b(express|Router)\b/.test(loaded.code)) continue;

    // const app = express()   const router = Router()   const r = express.Router()
    const routers = new Set();
    traverse(loaded.ast, {
      VariableDeclarator(p) {
        const init = p.node.init;
        if (p.node.id.type !== 'Identifier' || init?.type !== 'CallExpression') return;
        const c = init.callee;
        const name = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' ? c.property.name : null;
        if (name === 'express') apps.add(`${file}#${p.node.id.name}`);
        if (name === 'express' || name === 'Router') routers.add(p.node.id.name);
      },
    });
    if (!routers.size) continue;

    traverse(loaded.ast, {
      CallExpression(p) {
        const c = p.node.callee;
        if (c.type !== 'MemberExpression' || c.object.type !== 'Identifier' || !routers.has(c.object.name)) return;
        const method = c.property.name;
        const args = p.get('arguments');
        const first = args[0]?.isStringLiteral() ? args[0].node.value : null;

        if (ROUTE_METHODS.includes(method) && first != null) {
          routes.push({ file, varName: c.object.name, method: method.toUpperCase(), path: first, line: p.node.loc.start.line, handlerIndex: args.length - 2 });
        } else if (method === 'use') {
          // app.use('/api', statsRoutes, salesRoutes)   app.use(router)
          // app.use('/api/x', require('./routes/x'))  — imported, required or local
          const prefix = first ?? '';
          for (const a of args.slice(first != null ? 1 : 0)) {
            const required = inlineRequire(a.node);
            if (required) {
              const childFile = resolveImport(file, required);
              if (childFile) mounts.push({ file, varName: c.object.name, prefix, child: { file: childFile } });
              continue;
            }
            if (!a.isIdentifier()) continue;
            const binding = a.scope.getBinding(a.node.name);
            const t = binding && importTarget(binding, file);
            if (t) mounts.push({ file, varName: c.object.name, prefix, child: { file: t.file } });
            else if (routers.has(a.node.name)) mounts.push({ file, varName: c.object.name, prefix, child: { file, varName: a.node.name } });
          }
        }
      },
    });
  }

  // Prefixes for each router: apps are at "", mounted routers inherit their
  // parent's prefixes + the mount path. A few passes handle nesting.
  const prefixes = new Map(); // "file#var" or "file" → Set of prefixes
  const add = (key, prefix) => (prefixes.get(key) ?? prefixes.set(key, new Set()).get(key)).add(prefix);
  for (const app of apps) add(app, '');
  for (let pass = 0; pass < 5; pass++) {
    for (const m of mounts) {
      const parent = prefixes.get(`${m.file}#${m.varName}`) ?? prefixes.get(m.file);
      if (!parent) continue;
      const childKey = m.child.varName ? `${m.child.file}#${m.child.varName}` : m.child.file;
      for (const p of parent) add(childKey, joinPath(p, m.prefix));
    }
  }

  return routes.flatMap((r) => {
    const own = prefixes.get(`${r.file}#${r.varName}`) ?? prefixes.get(r.file) ?? new Set(['']);
    return [...own].map((prefix) => ({ ...r, fullPath: joinPath(prefix, r.path) }));
  });
}

// require('./routes/x') written inline → './routes/x'
const inlineRequire = (node) =>
  node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments[0]?.type === 'StringLiteral'
    ? node.arguments[0].value
    : null;

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= MAX_FILES) break;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) listFiles(path.join(dir, entry.name), out);
    } else if (SOURCE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const joinPath = (a, b) => `/${[a, b].join('/').split('/').filter(Boolean).join('/')}`;

// --- 3. Matching ------------------------------------------------------------------

// URL pattern from the frontend ↔ route path from the backend.
//   "/api/users/*"  ↔  "/api/users/:id"   ✓
//   "*/sales"       ↔  "/api/sales"       ✓ (a leading * is an unknown base URL)
function matchRoute(call, routes) {
  const url = call.url.replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0];
  const segs = url.split('/').filter(Boolean);
  const candidates = routes.filter((r) => (r.method === call.method || r.method === 'ALL') && segmentsMatch(segs, r.fullPath.split('/').filter(Boolean)));
  // Prefer the most specific route (fewest :params).
  candidates.sort((a, b) => (a.fullPath.match(/:/g)?.length ?? 0) - (b.fullPath.match(/:/g)?.length ?? 0));
  return candidates[0] ?? null;
}

function segmentsMatch(url, route) {
  if (url[0]?.startsWith('*') && url[0] !== '*') url = ['*', ...url.slice(1)];
  if (url[0] === '*' && url.length <= route.length) {
    // leading * = base URL: try it against every possible number of leading segments
    for (let skip = 0; skip <= route.length - url.length + 1; skip++) {
      if (segmentsMatch(url.slice(1), route.slice(skip))) return true;
    }
  }
  if (url.length !== route.length) return false;
  return url.every((s, i) => s === route[i] || s === '*' || route[i].startsWith(':'));
}

// --- 4. Route → handler → SQL -----------------------------------------------------

async function describeRoute(route, rootDir) {
  const target = (await resolveHandler(route.file, route.line, route.handlerIndex).catch(() => null)) ?? {
    file: route.file,
    line: route.line,
  };
  const loaded = await loadFile(target.file).catch(() => null);
  const fn = loaded?.ast && functionAtLine(loaded.ast, target.line);

  return {
    method: route.method,
    path: route.fullPath,
    file: route.file, // where it's registered (router.get…), absolute like runtime
    line: route.line,
    handler: { file: target.file, line: target.line, name: (fn && functionName(fn)) ?? null, index: route.handlerIndex },
    queries: fn ? await queriesIn(target.file, fn, rootDir) : [],
  };
}

// Every db.query('SQL') / pool.query(`SQL`) / pool.execute('SQL') reachable
// from the handler, and every Prisma / Drizzle call (see orm.js).
async function queriesIn(file, fn, rootDir) {
  const out = [];
  const seen = new Set();
  for (const node of await collectFunctions(file, fn)) {
    const candidates = []; // possible ORM calls — resolving their tables reads other files
    node.fn.traverse({
      CallExpression(p) {
        const c = p.node.callee;
        if (c.type !== 'MemberExpression') return;
        const method = c.property.name;
        if (!RAW_SQL.has(method)) return void candidates.push(p);
        const sql = sqlArg(p.get('arguments')[0]);
        // .execute() is also Drizzle's db.execute(sql`…`) and many a
        // non-database method (bus.execute('CreateUser')) — only SQL-looking
        // text counts, the rest goes to the ORM check like any other call.
        if (method === 'execute' && !LOOKS_SQL.test(sql ?? '')) return void candidates.push(p);
        if (!sql) return;
        const key = `${node.file}:${p.node.loc.start.line}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ sql, file: node.file, line: p.node.loc.start.line, tables: tablesInSql(sql) });
      },
    });
    if (!candidates.length) continue;
    const { code } = await loadFile(node.file);
    // One entry per chain: db.select().from(users).leftJoin(orders, …) → users + orders.
    // The outermost call of a chain comes first, so its label covers the rest.
    const chains = new Map(); // chain's outermost call → entry
    for (const p of candidates) {
      const orm = await ormQuery(p, node.file, code, rootDir);
      if (!orm) continue;
      const top = chainTop(p);
      const entry = chains.get(top);
      if (entry) {
        for (const t of orm.tables) if (!entry.tables.some((e) => e.name === t.name)) entry.tables.push(t);
        continue;
      }
      const key = `${node.file}:${p.node.loc.start.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const created = { ...orm, file: node.file, line: p.node.loc.start.line };
      chains.set(top, created);
      out.push(created);
    }
  }
  return out;
}

// Raw SQL methods: pg's .query(), mysql2's .query() and .execute().
const RAW_SQL = new Set(['query', 'execute']);
const LOOKS_SQL = /^\s*(select|insert|update|delete|replace|with)\b/i;

// The SQL text passed to query() / execute(), when it's written right there:
//   'SELECT …'   `SELECT …`   { sql: 'SELECT …', values }   (mysql2 options)
// Plain templates only — sql`…` (a tagged template) is Drizzle's, not text.
function sqlArg(arg) {
  if (arg?.isObjectExpression()) arg = propertyOf(arg, 'sql');
  if (arg?.isStringLiteral()) return arg.node.value;
  if (arg?.isTemplateLiteral()) return arg.node.quasis.map((q) => q.value.cooked).join('0');
  return null;
}

// a.b().c().d() — the outermost call of the chain a call sits in.
function chainTop(p) {
  let top = p.node;
  let cur = p;
  while (cur.parentPath?.isMemberExpression({ object: cur.node }) && cur.parentPath.parentPath?.isCallExpression({ callee: cur.parentPath.node })) {
    cur = cur.parentPath.parentPath;
    top = cur.node;
  }
  return top;
}
