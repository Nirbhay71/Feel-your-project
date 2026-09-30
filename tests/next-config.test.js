// withFeel (@feel-dev/next's index.js): what it changes in a Next config, and
// that it keeps what the app already had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withFeel } from '../packages/next/src/index.js';

const DEV = 'phase-development-server';
const BUILD = 'phase-production-build';
const BACKEND = ['@feel-dev/node', '@feel-dev/agent'];

test.afterEach(() => delete process.env.__FEEL_NEXT);

test('outside next dev: only keeps Feel’s backend packages out of the server bundle', async () => {
  const user = { reactStrictMode: true, serverExternalPackages: ['sharp'] };
  const config = await withFeel(user)(BUILD, {});
  // @feel-dev/next itself is bundled: the agent route then needs nothing at
  // runtime and answers 404 even without Feel installed (--omit=dev).
  assert.deepEqual(config, { reactStrictMode: true, serverExternalPackages: ['sharp', ...BACKEND] });
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
      basePath: '/docs',
      env: { THEIRS: '1' },
    },
    { root, database: 'postgres://x', projectRoot: '..', allowedAddresses: ['192.168.1.20'] },
  )(DEV, {});

  assert.deepEqual(config.serverExternalPackages, ['sharp', '@feel-dev/node', '@feel-dev/next', '@feel-dev/agent', 'drizzle-orm'], 'merged, deduped, transpiled ones left out');

  const rules = config.turbopack.rules['*.{js,jsx,ts,tsx,mjs}'];
  assert.equal(rules.length, 2);
  assert.deepEqual(rules.map((r) => r.loaders[0].options), [{ root, server: false }, { root, server: true }]);
  assert.deepEqual(rules[1].condition, { all: [{ not: 'foreign' }, 'node'] });
  assert.match(rules[0].loaders[0].loader, /loader\.cjs$/);

  assert.deepEqual(config.env, { THEIRS: '1', FEEL_BASE_PATH: '/docs' }, 'the browser script learns the basePath');
  assert.deepEqual(JSON.parse(process.env.__FEEL_NEXT), {
    root,
    projectRoot: path.resolve(root, '..'),
    database: 'postgres://x',
    basePath: '/docs',
    allowedHosts: ['192.168.1.5'],
    allowedAddresses: ['192.168.1.20'],
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

test('Next.js older than 16: a warning, and the config as it was', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feel-next15-'));
  fs.mkdirSync(path.join(root, 'node_modules', 'next'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'node_modules', 'next', 'package.json'), '{"name":"next","version":"15.5.4"}');
  const warn = t.mock.method(console, 'warn', () => {});
  try {
    const user = { reactStrictMode: true };
    assert.equal(await withFeel(user, { root })(DEV, {}), user);
    assert.match(warn.mock.calls[0].arguments[0], /Next\.js 15 .*16 or later/);
    assert.equal(process.env.__FEEL_NEXT, undefined, 'the agent route stays off');

    fs.writeFileSync(path.join(root, 'node_modules', 'next', 'package.json'), '{"name":"next","version":"16.0.0"}');
    assert.ok((await withFeel(user, { root })(DEV, {})).turbopack, 'Next 16 is fine');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('package: every public entry has its TypeScript declarations (strict TS apps need them to build)', () => {
  const dir = path.resolve('packages/next');
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const entry of ['.', './client', './agent', './register']) {
    const types = pkg.exports[entry]?.types;
    assert.ok(types && fs.existsSync(path.join(dir, types)), `${entry} → ${types}`);
    assert.equal(Object.keys(pkg.exports[entry])[0], 'types', `${entry}: "types" comes first`);
  }
  assert.ok(pkg.files.includes('types'));
  assert.equal(pkg.peerDependencies.next, '>=16');
});
