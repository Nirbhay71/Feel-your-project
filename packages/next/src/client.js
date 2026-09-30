// Browser side for Next.js. Import it from instrumentation-client.js:
//
//   import '@feel-dev/next/client';
//
// Next runs that file before any of your app's code, so fetch and
// XMLHttpRequest are wrapped before the first request goes out — the same
// guarantee the Vite plugin gets by putting its script first in <head>.
// Only resolved in development (see package.json "exports"); production
// builds get empty.js instead.

// First: where the agent is, if the app has a basePath.
import './base-path.js';
import '@feel-dev/client';
// Patches the app's own axios when it has one; an empty module otherwise
// (withFeel sets up the alias — see index.js).
import '@feel-dev/next/axios';
