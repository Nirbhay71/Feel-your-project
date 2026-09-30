// Per-request context, shared by the Express, pg, mysql2 and ORM patches.
//
// AsyncLocalStorage keeps a value alive across every `await` and callback
// that starts inside als.run(). So a query made deep inside a handler
// (handler → service → db.js → pool.query) still knows which request it
// belongs to, without passing anything around.

import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import fs from 'node:fs';
import { findSourceMap, SourceMap } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const als = new AsyncLocalStorage();

// Where the user's code started the query that is running now, when that
// line is no longer on the stack. ORMs like Drizzle build the query in your
// code but only send it later (on `await`), from a fresh stack. Their patch
// remembers the line and puts it here around the send (see drizzle.js).
export const siteStore = new AsyncLocalStorage();

// A database driver calls your callback from its socket's event handler, and
// that handler runs in the context of whoever opened the socket — for a
// pooled connection, some earlier request (or none). Bind the callback to
// the request that is running now, so the queries it sends in turn land in
// the right request. Outside a request the callback is returned as it is.
export function bindToRequest(fn) {
  return als.getStore() && typeof fn === 'function' ? AsyncResource.bind(fn) : fn;
}

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
    const name = nameOf(site);
    const file = name && toPath(name);
    if (!file || file.startsWith(THIS_DIR) || isLibrary(file)) continue;
    const pos = { file, line: site.getLineNumber(), column: site.getColumnNumber() };
    if (!isBundled(file)) return pos;
    // Next.js runs a bundle of your code: map the frame back to your file.
    const mapped = mapBundled(name, pos);
    if (mapped && !isLibrary(mapped.file)) return mapped;
  }
  return siteStore.getStore() ?? NONE;
}

// --- Bundled code (Next.js) -------------------------------------------------
//
// Under `next dev` your route handlers don't run from app/api/…/route.ts but
// from a bundle: Turbopack writes .next/dev/server/chunks/….js (with a .js.map
// next to it), webpack evals each module as webpack-internal:///(rsc)/./lib/db.ts
// with an inline map. Next starts Node with --enable-source-maps, so
// findSourceMap() knows both; the .map on disk covers the case where it doesn't.
//
// After a hot reload Turbopack runs the new code of the edited module under
// its own name, file:///…/chunks/x.js?<module id> — the query is what tells
// it apart from the chunk's first version, so maps are looked up by that
// full name first; the plain path would find the old map.

const NEXT_DIR = `${path.sep}.next${path.sep}`;
const isBundled = (file) => file.includes(NEXT_DIR) || file.startsWith('webpack-internal:');

const diskMaps = new Map(); // bundle file → { mtimeMs, map }

// name: the frame's script name as V8 reports it (a file:// URL with its
// query, a path, or webpack-internal:///…); pos.file: the same as a path.
function mapBundled(name, { file, line, column }) {
  const map = knownSourceMap(name) ?? sourceMapOf(file);
  if (!map || line == null) return null;
  const origin = map.findOrigin(line, column ?? 1);
  const source = origin?.fileName;
  if (!source || origin.lineNumber == null) return null;
  // Sources like turbopack:///[turbopack]/… or webpack://next/… are Next's own.
  let mappedFile;
  if (source.startsWith('file://')) mappedFile = fileURLToPath(source);
  else if (path.isAbsolute(source)) mappedFile = source;
  else return null;
  return { file: mappedFile, line: origin.lineNumber, column: origin.columnNumber };
}

function knownSourceMap(name) {
  try {
    return findSourceMap(name) ?? null;
  } catch {
    return null; // not a name Node knows
  }
}

function sourceMapOf(file) {
  const known = knownSourceMap(file);
  if (known) return known;
  if (file.startsWith('webpack-internal:')) return null; // inline maps only
  try {
    const { mtimeMs } = fs.statSync(`${file}.map`);
    const hit = diskMaps.get(file);
    if (hit?.mtimeMs === mtimeMs) return hit.map;
    const map = new SourceMap(JSON.parse(fs.readFileSync(`${file}.map`, 'utf8')));
    diskMaps.set(file, { mtimeMs, map });
    return map;
  } catch {
    return null;
  }
}

// True when the code calling us (the first frame that isn't ours) lives in
// the given package — e.g. pg-pool handing a query on to a pg Client.
export function calledFrom(pkg) {
  const marker = `${path.sep}node_modules${path.sep}${pkg}${path.sep}`;
  return callerFile()?.includes(marker) ?? false;
}

// The file of the code calling us (the first frame that isn't ours), or
// null. For when the package isn't precise enough and the exact file
// matters — e.g. mysql2's pool handing a query on to a connection (mysql2.js).
export function callerFile() {
  for (const site of stackSites(callerFile)) {
    const name = nameOf(site);
    const file = name && toPath(name);
    if (!file || file.startsWith(THIS_DIR)) continue;
    return file;
  }
  return null;
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

// The script a frame runs in, as V8 names it. webpack's eval'd modules have
// no file name, only the name their //# sourceURL gave them
// (webpack-internal:///(rsc)/./lib/db.ts). null for Node's own modules.
function nameOf(site) {
  const name = site.getFileName() ?? site.getScriptNameOrSourceURL?.();
  return !name || name.startsWith('node:') ? null : name;
}

// file:///app/x.js?123 → /app/x.js; anything else stays as it is.
function toPath(name) {
  if (!name.startsWith('file:')) return name;
  try {
    return fileURLToPath(name);
  } catch {
    return null;
  }
}

const isLibrary = (file) => file.includes(`${path.sep}node_modules${path.sep}`);
