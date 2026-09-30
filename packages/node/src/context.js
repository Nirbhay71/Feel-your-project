// Per-request context, shared by the Express, pg and ORM patches.
//
// AsyncLocalStorage keeps a value alive across every `await` and callback
// that starts inside als.run(). So a query made deep inside a handler
// (handler → service → db.js → pool.query) still knows which request it
// belongs to, without passing anything around.

import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const als = new AsyncLocalStorage();

// Where the user's code started the query that is running now, when that
// line is no longer on the stack. ORMs like Drizzle build the query in your
// code but only send it later (on `await`), from a fresh stack. Their patch
// remembers the line and puts it here around the send (see drizzle.js).
export const siteStore = new AsyncLocalStorage();

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const NONE = { file: null, line: null, column: null };

// ORMs like Prisma sit many frames deep between your line and pg, and reach
// it through several awaits. V8 keeps those as "async" frames at the end of
// the stack — but only if the stack is long enough to include them.
const STACK_LIMIT = 100;

// The first stack frame that is the user's own code — not a library, not us.
// Looks through async frames too (`at async getUsers (…)`), so a query sent
// by an ORM after a few awaits still finds the line that asked for it.
// Returns { file, line, column } (all null if there is none).
export function callerSite() {
  for (const site of stackSites(callerSite)) {
    const file = fileOf(site);
    if (!file || file.startsWith(THIS_DIR) || isLibrary(file)) continue;
    return { file, line: site.getLineNumber(), column: site.getColumnNumber() };
  }
  return siteStore.getStore() ?? NONE;
}

// True when the code calling us (the first frame that isn't ours) lives in
// the given package — e.g. pg-pool handing a query on to a pg Client.
export function calledFrom(pkg) {
  const marker = `${path.sep}node_modules${path.sep}${pkg}${path.sep}`;
  for (const site of stackSites(calledFrom)) {
    const file = fileOf(site);
    if (!file || file.startsWith(THIS_DIR)) continue;
    return file.includes(marker);
  }
  return false;
}

function stackSites(below) {
  const { prepareStackTrace, stackTraceLimit } = Error;
  Error.prepareStackTrace = (_, callSites) => callSites; // structured frames
  Error.stackTraceLimit = Math.max(stackTraceLimit, STACK_LIMIT);
  const holder = {};
  Error.captureStackTrace(holder, below);
  const sites = holder.stack;
  Error.prepareStackTrace = prepareStackTrace;
  Error.stackTraceLimit = stackTraceLimit;
  return sites;
}

function fileOf(site) {
  const file = site.getFileName();
  if (!file || file.startsWith('node:')) return null;
  return file.startsWith('file:') ? fileURLToPath(file) : file;
}

const isLibrary = (file) => file.includes(`${path.sep}node_modules${path.sep}`);
