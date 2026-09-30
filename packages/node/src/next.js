// Layer 2 — Next.js: which route handler answered a request.
//
// Next has no router.get(...) to patch: a route is a file, and its handler is
// the function it exports (app/api/items/route.ts → export async function GET).
// @feel-dev/next's loader rewrites each route file at build time so every
// exported handler goes through one of these wrappers:
//
//   export async function GET(request) {…}
//   → async function GET(request) {…}
//     export const GET = wrapRouteHandler(GET, { file, line, name: 'GET', path: '/api/items' })
//
// The wrapper runs the handler inside the request context (so pg / mysql2 /
// Drizzle queries land in this request, see context.js) and adds the same
// X-Feel-Route header as Express routes get.

import { randomUUID } from 'node:crypto';
import { als } from './context.js';
import { HEADER, headerValue, hookHeaders } from './express.js';

// info: { file (absolute), line, name, path } — path in Express shape
// (/api/items/:id), the same the static scan reports, so the panel can
// tell a runtime request and a "possible call" are the same thing.
function newContext(method, info) {
  return {
    id: randomUUID(), // links database changes back to this request (see pg.js)
    method,
    path: info.path,
    handlers: [{ file: info.file, line: info.line, name: info.name ?? null, index: 0, direct: true }],
    queries: [],
  };
}

// App Router: (request, context) → Response.
export function wrapRouteHandler(fn, info) {
  if (typeof fn !== 'function') return fn;
  const wrapped = async function (request, context) {
    const ctx = newContext(request?.method ?? info.name, info);
    const res = await als.run(ctx, () => fn.call(this, request, context));
    return withHeader(res, ctx);
  };
  Object.defineProperty(wrapped, 'name', { value: fn.name, configurable: true });
  return wrapped;
}

// Pages Router API routes: (req, res) like Express — the header goes on at
// res.writeHead(), after the handler's queries ran.
export function wrapPagesHandler(fn, info) {
  if (typeof fn !== 'function') return fn;
  const wrapped = function (req, res) {
    const ctx = newContext(req?.method ?? 'GET', info);
    if (res) hookHeaders(res, ctx);
    return als.run(ctx, () => fn.apply(this, arguments));
  };
  Object.defineProperty(wrapped, 'name', { value: fn.name, configurable: true });
  return wrapped;
}

// Add the header to a Response. Some responses have read-only headers
// (Response.redirect(), a fetch() passed straight through); those get copied
// into a new Response with the same body, status and headers. Anything that
// isn't a Response is handed back as it is — Next reports that itself.
function withHeader(res, ctx) {
  if (!res?.headers || typeof res.headers.set !== 'function') return res;
  const value = headerValue(ctx);
  try {
    setHeader(res.headers, value);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    setHeader(copy.headers, value);
    return copy;
  }
}

function setHeader(headers, value) {
  headers.set(HEADER, value);
  // Lets the browser read the header even if the API is on another origin
  // (added to the app's own list, if it has one).
  const exposed = headers.get('Access-Control-Expose-Headers');
  if (!exposed) headers.set('Access-Control-Expose-Headers', HEADER);
  else if (!exposed.toLowerCase().includes(HEADER.toLowerCase())) headers.set('Access-Control-Expose-Headers', `${exposed}, ${HEADER}`);
}
