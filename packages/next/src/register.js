// Backend patches for Next.js. Load it from instrumentation.js:
//
//   export async function register() {
//     if (process.env.NODE_ENV === 'development' && process.env.NEXT_RUNTIME === 'nodejs') {
//       await import('@feel-dev/next/register');
//     }
//   }
//
// Same as @feel-dev/node/register (pg, mysql2, Drizzle, Express), but reached
// through @feel-dev/next, so it works with package managers that only let
// your app import its own direct dependencies (pnpm).

import '@feel-dev/node/register';
