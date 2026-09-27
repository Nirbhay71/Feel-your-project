// Layer 2 — Express: which route and handler answered a request.
//
// Every route handler is wrapped so that, when it runs, it records where it
// was registered (router.get('/stats', getStats) → routes/stats.js:7).
// Right before the response headers go out, everything collected for the
// request — handlers + SQL queries (Layer 3) — is sent in one header:
//
//   X-Feel-Route: {"id":"…","method":"GET","path":"/api/stats","handlers":[…],"queries":[…]}

import { randomUUID } from 'node:crypto';
import { als, callerSite } from './context.js';

const HEADER = 'X-Feel-Route';
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'];

export function instrumentExpress(express) {
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

// Wrap a handler: record it, then run it inside the request's context so
// SQL queries it makes are attached to this request.
// Express treats 4-argument functions as error handlers, so keep the arity.
function wrap(handler, info) {
  if (handler.length === 4) {
    return function (err, req, res, next) {
      const ctx = enter(req, res, info);
      return als.run(ctx, () => handler.apply(this, arguments));
    };
  }
  return function (req, res, next) {
    const ctx = enter(req, res, info);
    return als.run(ctx, () => handler.apply(this, arguments));
  };
}

// Get (or create) this request's context and record the handler in it.
function enter(req, res, info) {
  let ctx = req.__feel;
  if (!ctx) {
    // id: links database changes back to this request (see pg.js).
    ctx = req.__feel = { id: randomUUID(), method: req.method, path: null, handlers: [], queries: [] };
    hookHeaders(res, ctx);
  }
  ctx.path = routePath(req);
  ctx.handlers.push(info);
  return ctx;
}

// Mount path + route path, without a trailing slash:
//   app.use('/api/employees', router) + router.get('/') → "/api/employees"
function routePath(req) {
  const full = req.baseUrl + (typeof req.route?.path === 'string' ? req.route.path : '');
  return full.length > 1 ? full.replace(/\/+$/, '') : full || '/';
}

// Node calls res.writeHead() right before headers are sent — even when the
// app only calls res.json() / res.end(). That's the last moment to add ours,
// and by then the handler's queries have finished.
function hookHeaders(res, ctx) {
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    if (!res.headersSent) {
      res.setHeader(HEADER, encodeURIComponent(JSON.stringify(ctx)));
      // Lets the browser read the header even if the API is on another origin.
      res.setHeader('Access-Control-Expose-Headers', HEADER);
    }
    return writeHead.apply(this, args);
  };
}
