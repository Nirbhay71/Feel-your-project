// Layer 2 — backend side (runtime).
//
// Patches Express so every route handler reports where it was registered:
//
//   router.get('/stats', getStats)     ← we record this file:line when it runs
//
// When a request hits that route, the response carries a header:
//
//   X-Feel-Route: {"method":"GET","path":"/api/stats",
//                  "handlers":[{"file":"…/routes/stats.js","line":7,"index":0,"name":"getStats"}]}
//
// The browser client reads it, and the agent statically follows `getStats`
// to the file/line where the function is actually defined.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADER = 'X-Feel-Route';
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'];
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

export function instrument(express) {
  // app.get(), router.get() and app.route().get() all end up calling
  // Route.prototype.get — so patching Route catches every style.
  // Route isn't exported, so grab it from a throwaway router.
  const Route = express.Router().route('/').constructor;
  if (Route.prototype.__feelPatched) return;
  Route.prototype.__feelPatched = true;

  for (const method of METHODS) {
    const original = Route.prototype[method];
    if (typeof original !== 'function') continue;

    Route.prototype[method] = function (...handlers) {
      const site = callerSite(); // where the user wrote router.get(...)
      const wrapped = handlers
        .flat(Infinity)
        .map((h, index) => (typeof h === 'function' ? wrap(h, { ...site, index, name: h.name || null }) : h));
      return original.apply(this, wrapped);
    };
  }
}

// Wrap a handler so that, when it runs, it adds itself to the response header.
// Express treats 4-argument functions as error handlers, so keep the arity.
function wrap(handler, info) {
  const record = (req, res) => {
    const handlers = (req.__feelHandlers ??= []);
    handlers.push(info);
    if (res.headersSent) return;
    const route = { method: req.method, path: req.baseUrl + (req.route?.path ?? ''), handlers };
    res.setHeader(HEADER, encodeURIComponent(JSON.stringify(route)));
    // Lets the browser read the header even if the API is on another origin.
    res.setHeader('Access-Control-Expose-Headers', HEADER);
  };

  if (handler.length === 4) {
    return function (err, req, res, next) {
      record(req, res);
      return handler.apply(this, arguments);
    };
  }
  return function (req, res, next) {
    record(req, res);
    return handler.apply(this, arguments);
  };
}

// The first stack frame that is the user's own code — not Express, not us.
function callerSite() {
  const original = Error.prepareStackTrace;
  Error.prepareStackTrace = (_, callSites) => callSites; // structured frames
  const holder = {};
  Error.captureStackTrace(holder, callerSite);
  const sites = holder.stack;
  Error.prepareStackTrace = original;

  for (const site of sites) {
    let file = site.getFileName();
    if (!file || file.startsWith('node:')) continue;
    if (file.startsWith('file:')) file = fileURLToPath(file);
    if (file.startsWith(THIS_DIR) || file.includes(`${path.sep}node_modules${path.sep}`)) continue;
    return { file, line: site.getLineNumber(), column: site.getColumnNumber() };
  }
  return { file: null, line: null, column: null };
}
