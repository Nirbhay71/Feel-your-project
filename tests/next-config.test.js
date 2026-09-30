// withFeel (@feel-dev/next's index.js): what it changes in a Next config, and
// that it keeps what the app already had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { withFeel } from '../packages/next/src/index.js';

const DEV = 'phase-development-server';
const BUILD = 'phase-production-build';
const OWN = ['@feel-dev/next', '@feel-dev/node', '@feel-dev/agent'];

test.afterEach(() => delete process.env.__FEEL_NEXT);

test('outside next dev: only keeps Feel packages out of the server bundle', async () => {
  const user = { reactStrictMode: true, serverExternalPackages: ['sharp'] };
  const config = await withFeel(user)(BUILD, {});
  assert.deepEqual(config, { reactStrictMode: true, serverExternalPackages: ['sharp', ...OWN] });
  assert.equal(config.turbopack, undefined);
  assert.equal(config.webpack, undefined);
  assert.equal(process.env.__FEEL_NEXT, undefined);
  assert.deepEqual(user.serverExternalPackages, ['sharp'], 'user config not mutated');
});

test('next dev: loader rules, externals, settings for the agent route', async () => {
  const root = path.resolve('/proj');
  const config = await withFeel(
    {
      serverExternalPackages: ['sharp', '@feel-dev/node'],
      transpilePackages: ['mysql2'],
      allowedDevOrigins: ['192.168.1.5'],
    },
    { root, database: 'postgres://x', projectRoot: '..' },
  )(DEV, {});

  assert.deepEqual(config.serverExternalPackages, ['sharp', '@feel-dev/node', '@feel-dev/next', '@feel-dev/agent', 'drizzle-orm'], 'merged, deduped, transpiled ones left out');

  const rules = config.turbopack.rules['*.{js,jsx,ts,tsx,mjs}'];
  assert.equal(rules.length, 2);
  assert.deepEqual(rules.map((r) => r.loaders[0].options), [{ root, server: false }, { root, server: true }]);
  assert.deepEqual(rules[1].condition, { all: [{ not: 'foreign' }, 'node'] });
  assert.match(rules[0].loaders[0].loader, /loader\.cjs$/);

  assert.deepEqual(JSON.parse(process.env.__FEEL_NEXT), {
    root,
    projectRoot: path.resolve(root, '..'),
    database: 'postgres://x',
    allowedHosts: ['192.168.1.5'],
  });
});

test('function config, and the app’s own webpack hook and Turbopack rules are kept', async () => {
  const calls = [];
  const theirRule = { loaders: ['svg-loader'] };
  const userConfig = async (phase) => ({
    turbopack: { rules: { '*.svg': theirRule, '*.{js,jsx,ts,tsx,mjs}': theirRule } },
    webpack(config, ctx) {
      calls.push(phase, ctx.isServer);
      config.module.rules.push({ theirs: true });
      return config;
    },
  });
  const config = await withFeel(userConfig, { root: path.resolve('/proj') })(DEV, {});
  assert.equal(config.turbopack.rules['*.svg'], theirRule);
  assert.equal(config.turbopack.rules['*.{js,jsx,ts,tsx,mjs}'].length, 3, 'ours first, theirs after');
  assert.equal(config.turbopack.rules['*.{js,jsx,ts,tsx,mjs}'][2], theirRule);

  const webpackConfig = { module: { rules: [{ next: true }] }, resolve: { alias: {} } };
  const out = config.webpack(webpackConfig, { isServer: true, nextRuntime: 'nodejs' });
  assert.deepEqual(calls, [DEV, true], 'their hook ran');
  assert.deepEqual(out.module.rules.slice(0, 2), [{ next: true }, { theirs: true }]);
  const ours = out.module.rules.at(-1);
  assert.ok(ours.test.test('a.tsx') && ours.exclude.test('/x/node_modules/y.js'), 'ours last: runs before SWC');
  assert.equal(ours.use[0].options.server, true);

  const edge = config.webpack({ module: { rules: [] }, resolve: { alias: {} } }, { isServer: true, nextRuntime: 'edge' });
  assert.equal(edge.module.rules.at(-1).use[0].options.server, false, 'edge builds never wrap route handlers');
});
