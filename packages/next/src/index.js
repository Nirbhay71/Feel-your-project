// @feel-dev/next — Feel for Next.js (App Router, Turbopack or webpack).
//
//   // next.config.mjs
//   import { withFeel } from '@feel-dev/next';
//   export default withFeel({ /* your config */ }, { database: process.env.DATABASE_URL });
//
// Under `next dev`, withFeel:
//   - adds a loader for your own .js/.jsx/.ts/.tsx files (loader.cjs): it
//     tags DOM elements with where they're written, and wraps route handlers
//     so each request reports its handler and SQL
//   - keeps Feel's packages and the database drivers out of the server
//     bundle (serverExternalPackages), so the pg / mysql2 patches loaded by
//     instrumentation.js and your route handlers share one copy of each
//   - tells the agent route (agent.js) where the project is
// In every other phase it only keeps Feel's packages out of the bundle —
// nothing of Feel runs in a production build.
//
// Two small files of your own finish the setup (see README):
// instrumentation.js / instrumentation-client.js and the agent route.

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Next's phase names, written out so this file doesn't need next itself.
const DEV_PHASE = 'phase-development-server';

const LOADER = fileURLToPath(new URL('./loader.cjs', import.meta.url));
const OWN_PACKAGES = ['@feel-dev/next', '@feel-dev/node', '@feel-dev/agent'];
// Loaded by instrumentation.js *and* imported by route handlers: bundled,
// they'd be two copies and only one would be patched. (Next already keeps
// pg, Prisma and Express external by default.)
const DRIVERS = ['drizzle-orm', 'mysql2'];
const SOURCE_FILES = '*.{js,jsx,ts,tsx,mjs}';

// nextConfig: your config — an object, or a function (phase, ctx) => config
// options.database:     connection string for the table view (optional)
// options.projectRoot:  folder with frontend and backend, if not the nearest .git
// options.root:         the Next project (default: the folder next runs in)
// options.allowedHosts: extra host names that may reach the agent (default:
//                       your allowedDevOrigins)
export function withFeel(nextConfig = {}, options = {}) {
  return async (phase, ctx) => {
    const config = (typeof nextConfig === 'function' ? await nextConfig(phase, ctx) : nextConfig) ?? {};
    if (phase !== DEV_PHASE) return { ...config, serverExternalPackages: externals(config, OWN_PACKAGES) };

    const root = path.resolve(options.root ?? process.cwd());
    // Read by the agent route, which runs in this same process.
    process.env.__FEEL_NEXT = JSON.stringify({
      root,
      projectRoot: options.projectRoot && path.resolve(root, options.projectRoot),
      database: options.database,
      allowedHosts: options.allowedHosts ?? config.allowedDevOrigins ?? [],
    });

    const hasAxios = canResolve(root, 'axios');
    return {
      ...config,
      serverExternalPackages: externals(config, [...OWN_PACKAGES, ...DRIVERS]),
      turbopack: turbopackConfig(config.turbopack, root, hasAxios),
      webpack: webpackHook(config.webpack, root, hasAxios),
    };
  };
}

export default withFeel;

// The app's own list + ours, without duplicates. Packages the app asked Next
// to transpile can't also be external — Next refuses that — so theirs wins.
function externals(config, ours) {
  const transpiled = new Set(config.transpilePackages ?? []);
  return [...new Set([...(config.serverExternalPackages ?? []), ...ours])].filter((p) => !transpiled.has(p));
}

// Turbopack: two rules for your source files (never packages — "foreign"):
// one for the browser build, one for the Node.js server build, which also
// wraps route handlers. The loader runs in a worker, so it gets what it needs
// as options rather than from process.env.
function turbopackConfig(turbopack = {}, root, hasAxios) {
  const rule = (server) => ({
    loaders: [{ loader: LOADER, options: { root, server } }],
    condition: { all: [{ not: 'foreign' }, server ? 'node' : { not: 'node' }] },
  });
  const rules = { ...turbopack.rules };
  rules[SOURCE_FILES] = [rule(false), rule(true), ...[].concat(rules[SOURCE_FILES] ?? [])];

  const resolveAlias = { ...turbopack.resolveAlias };
  if (hasAxios) resolveAlias['@feel-dev/next/axios'] = '@feel-dev/next/axios-patch';
  return { ...turbopack, rules, resolveAlias };
}

// webpack (`next dev --webpack`): your hook first, then our rule last in the
// list — webpack runs a rule list bottom-up, so ours sees the source before
// Next's SWC compiles it.
function webpackHook(userHook, root, hasAxios) {
  return (config, context) => {
    const out = typeof userHook === 'function' ? userHook(config, context) : config;
    const server = context.isServer && context.nextRuntime !== 'edge';
    out.module.rules.push({
      test: /\.(js|jsx|ts|tsx|mjs)$/,
      exclude: /node_modules/,
      use: [{ loader: LOADER, options: { root, server } }],
    });
    if (hasAxios && !context.isServer) {
      const alias = out.resolve.alias;
      if (Array.isArray(alias)) alias.push({ name: '@feel-dev/next/axios', alias: '@feel-dev/next/axios-patch', onlyModule: true });
      else out.resolve.alias = { ...alias, '@feel-dev/next/axios$': '@feel-dev/next/axios-patch' };
    }
    return out;
  };
}

function canResolve(root, name) {
  try {
    createRequire(path.join(root, 'package.json')).resolve(name);
    return true;
  } catch {
    return false;
  }
}
