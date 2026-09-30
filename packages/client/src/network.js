// Layer 2 — browser side (runtime).
//
// Wraps fetch and XMLHttpRequest (used by axios) so every API call is recorded
// with:
//   - a stack trace taken at the moment the request was made → which of your
//     functions made it (the agent maps it back to original lines)
//   - the X-Feel-Route response header set by @feel-dev/node → which backend
//     route and handler answered it, and which SQL queries it ran
//
// Must be imported before the app runs, so it's the first import of index.js
// and the client script is injected at the top of <head>.

const AGENT = '/__feel';
const MAX_REQUESTS = 200;

const requests = [];
const listeners = new Set();

export const getRequests = () => requests;
export const onRequestsChange = (fn) => listeners.add(fn);

const originalFetch = window.fetch;

async function record(entry) {
  requests.push(entry);
  if (requests.length > MAX_REQUESTS) requests.shift();

  // Ask the agent to turn the raw stack into file/line/function/component,
  // and which tables each SQL query touched (Layer 3).
  const queries = entry.backend?.queries ?? [];
  const [frames] = await Promise.all([
    agentPost('stack', { stack: entry.stack }).then((r) => r.frames),
    ...queries.map(async (q) => (q.tables = await tablesFor(q.sql))),
  ]);
  entry.frames = frames ?? [];

  // If the request wrote to the database, fetch exactly which rows it changed.
  // (The response only arrives after its queries — and their triggers — ran.)
  const wrote = queries.some((q) => q.tables?.some((t) => t.access === 'write'));
  if (wrote && entry.backend.id) {
    try {
      const res = await originalFetch(`${AGENT}/db/changes?request=${encodeURIComponent(entry.backend.id)}`);
      if (res.ok) entry.changes = (await res.json()).changes;
    } catch {
      // no database configured / agent unreachable — just skip
    }
  }
  listeners.forEach((fn) => fn());
}

// The browser request (if any) that a database change came from.
export const findRequest = (requestId) => requests.find((r) => r.backend?.id === requestId);

// Resolve any stack trace to original file/line/function (cached by text).
// Also used for React's fiber._debugStack (see fiber.js).
const stackCache = new Map(); // stack text → Promise<frames>
export function resolveStack(stack) {
  if (!stackCache.has(stack)) stackCache.set(stack, agentPost('stack', { stack }).then((r) => r.frames ?? []));
  return stackCache.get(stack);
}

const sqlCache = new Map(); // sql → Promise<tables>
function tablesFor(sql) {
  if (!sqlCache.has(sql)) sqlCache.set(sql, agentPost('sql', { sql }).then((r) => r.tables ?? []));
  return sqlCache.get(sql);
}

async function agentPost(route, body) {
  try {
    const res = await originalFetch(`${AGENT}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Feel': '1' }, // see the agent's cross-site check
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch {
    return {};
  }
}

function parseRoute(header) {
  if (!header) return null;
  try {
    return JSON.parse(decodeURIComponent(header));
  } catch {
    return null;
  }
}

// A stack trace of who's calling right now. Chrome keeps only 10 frames by
// default, and HTTP libraries use most of them (axios alone takes ~8), which
// would cut off your code — so capture up to 50 frames.
// Inside withStack(), the stack handed in wins (see axios.js).
export function captureStack() {
  if (handedStack) return handedStack;
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  const stack = new Error().stack;
  Error.stackTraceLimit = limit;
  return stack;
}

// Libraries that send requests *later* (axios with interceptors) lose your
// code from the stack by the time the request goes out. They can capture the
// stack when you call them, and run the actual send inside withStack().
let handedStack = null;
export function withStack(stack, fn) {
  const previous = handedStack;
  handedStack = stack;
  try {
    return fn();
  } finally {
    handedStack = previous;
  }
}

// Our own calls (agent, open-in-editor) aren't the app's traffic — and
// neither is Next.js's own: its dev overlay (/__nextjs…), its scripts
// (/_next/…) and the React Server Component payloads it fetches (?_rsc=…).
const isOwnRequest = (url) =>
  url.includes(`${AGENT}/`) || url.includes('/__open-in-editor') || url.includes('/__nextjs') || url.includes('/_next/') || /[?&]_rsc=/.test(url);

// --- fetch ----------------------------------------------------------------
window.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));
  if (isOwnRequest(url)) return originalFetch.apply(this, arguments);

  const method = (init?.method ?? input?.method ?? 'GET').toUpperCase();
  const stack = captureStack(); // who called fetch — must be taken synchronously
  const start = performance.now();

  try {
    const res = await originalFetch.apply(this, arguments);
    record({
      method,
      url,
      status: res.status,
      duration: performance.now() - start,
      backend: parseRoute(res.headers.get('X-Feel-Route')),
      stack,
    });
    return res;
  } catch (err) {
    record({ method, url, status: 0, error: err.message, duration: performance.now() - start, backend: null, stack });
    throw err;
  }
};

// --- XMLHttpRequest (axios, older libraries) -------------------------------
const { open, send } = XMLHttpRequest.prototype;

XMLHttpRequest.prototype.open = function (method, url) {
  this.__feel = { method: String(method).toUpperCase(), url: String(url) };
  return open.apply(this, arguments);
};

XMLHttpRequest.prototype.send = function () {
  const info = this.__feel;
  if (info && !isOwnRequest(info.url)) {
    const stack = captureStack();
    const start = performance.now();
    this.addEventListener('loadend', () => {
      record({
        ...info,
        status: this.status,
        duration: performance.now() - start,
        backend: parseRoute(this.getResponseHeader('X-Feel-Route')),
        stack,
      });
    });
  }
  return send.apply(this, arguments);
};
