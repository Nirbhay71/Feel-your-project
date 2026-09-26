// Per-request context, shared by the Express and pg patches.
//
// AsyncLocalStorage keeps a value alive across every `await` and callback
// that starts inside als.run(). So a query made deep inside a handler
// (handler → service → db.js → pool.query) still knows which request it
// belongs to, without passing anything around.

import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const als = new AsyncLocalStorage();

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

// The first stack frame that is the user's own code — not a library, not us.
// Returns { file, line, column } (all null if there is none).
export function callerSite() {
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
