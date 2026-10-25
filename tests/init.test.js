import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discover } from '../packages/init/src/detect.js';
import { planSetup, applyPlan, safeFile } from '../packages/init/src/setup.js';
import { configEdit, firstImport } from '../packages/init/src/transform.js';

const cli = fileURLToPath(new URL('../packages/init/bin/feel-init.js', import.meta.url));
function fixture(t, framework = 'vite') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feel-init-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => { const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, content); };
  const deps = framework === 'vite' ? { react: '^19.0.0', vite: '^7.0.0', '@vitejs/plugin-react': '^5.0.0' } : { react: '^19.0.0', next: '^16.0.0' };
  write('package.json', JSON.stringify({ type: 'module', dependencies: deps }));
  if (framework === 'vite') write('vite.config.js', "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n// keep this comment\nexport default defineConfig({ plugins: [react()], server: { port: 4321 } });\n");
  else write('src/app/page.tsx', 'export default function Page() { return null; }');
  const plan = () => planSetup({ root, app: discover(root).find((p) => p.framework) });
  return { root, write, plan };
}

test('Vite setup preserves config, inserts Feel first, backs up and is idempotent', (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.root, 'vite.config.js'), 'utf8');
  applyPlan(f.plan());
  const after = fs.readFileSync(path.join(f.root, 'vite.config.js'), 'utf8');
  assert.match(after, /plugins: \[feelPlugin\(\), react\(\)\]/);
  assert.ok(after.includes('// keep this comment') && after.includes('port: 4321'));
  assert.equal(fs.readFileSync(path.join(f.root, 'vite.config.js.feel-backup'), 'utf8'), before);
  assert.equal(f.plan().edits.length, 0);
});

test('Next setup merges instrumentation and uses src/app with TypeScript', (t) => {
  const f = fixture(t, 'next');
  f.write('tsconfig.json', '{}');
  f.write('next.config.mjs', 'export default { poweredByHeader: false };\n');
  f.write('src/instrumentation.ts', 'export async function register() { await existingTelemetry(); }\n');
  f.write('src/instrumentation-client.ts', "'use client';\nimport './telemetry';\n");
  const plan = f.plan();
  assert.equal(plan.manual.length, 0);
  applyPlan(plan);
  assert.match(fs.readFileSync(path.join(f.root, 'next.config.mjs'), 'utf8'), /feelWithNext\(\{ poweredByHeader: false \}\)/);
  const server = fs.readFileSync(path.join(f.root, 'src/instrumentation.ts'), 'utf8');
  assert.ok(server.includes('existingTelemetry()') && server.includes("process.env.NODE_ENV === 'development'"));
  const client = fs.readFileSync(path.join(f.root, 'src/instrumentation-client.ts'), 'utf8');
  assert.ok(client.startsWith("'use client';") && client.indexOf('@feel-dev/next/client') < client.indexOf('./telemetry'));
  assert.ok(fs.existsSync(path.join(f.root, 'src/app/%5F%5Ffeel/[...path]/route.ts')));
  assert.equal(f.plan().edits.length, 0);
});

test('existing agent route and unsupported instrumentation are preserved with manual steps', (t) => {
  const f = fixture(t, 'next');
  f.write('src/app/%5F%5Ffeel/[...path]/route.js', 'export const GET = customHandler;');
  f.write('src/instrumentation.js', 'export const register = makeRegister();');
  const plan = f.plan();
  assert.equal(plan.manual.length, 2);
  applyPlan(plan);
  assert.equal(fs.readFileSync(path.join(f.root, 'src/instrumentation.js'), 'utf8'), 'export const register = makeRegister();');
});

test('dynamic Vite configs get instructions instead of destructive edits', (t) => {
  const f = fixture(t);
  f.write('vite.config.js', "export default createConfig(process.env.MODE);\n");
  const plan = f.plan();
  assert.equal(plan.manual.length, 1);
  assert.equal(plan.edits.length, 0);
});

test('changed files invalidate the entire preview before any write', (t) => {
  const f = fixture(t);
  const plan = f.plan();
  f.write('vite.config.js', 'export default {};');
  assert.throws(() => applyPlan(plan), /changed after preview/);
  assert.ok(!fs.existsSync(path.join(f.root, '.gitignore')));
});

test('workspace detection distinguishes Next from React + Vite and Express', (t) => {
  const f = fixture(t);
  f.write('apps/web/package.json', JSON.stringify({ dependencies: { next: '^16.0.0', react: '^19.0.0' } }));
  f.write('apps/api/package.json', JSON.stringify({ main: 'src/server.js', dependencies: { express: '^5.0.0' } }));
  f.write('apps/api/src/server.js', "'use strict';\nrequire('dotenv').config();\n");
  const projects = discover(f.root);
  assert.deepEqual(projects.filter((p) => p.framework).map((p) => p.framework).sort(), ['next', 'vite']);
  const plan = planSetup({ root: f.root, app: projects.find((p) => p.framework === 'vite'), backend: projects.find((p) => p.express) });
  applyPlan(plan);
  const code = fs.readFileSync(path.join(f.root, 'apps/api/src/server.js'), 'utf8');
  assert.ok(code.startsWith("'use strict';") && code.indexOf('@feel-dev/node/register') < code.indexOf('dotenv'));
});

test('CJS Vite config and ESM server imports remain repeatable', () => {
  const code = "const { defineConfig } = require('vite'); module.exports = defineConfig({ plugins: [] });";
  const after = configEdit(code, 'vite.config.cjs', 'vite', '..');
  assert.equal(configEdit(after, 'vite.config.cjs', 'vite', '..'), after);
  const esm = firstImport("import './routes.js';", 'server.ts', '@feel-dev/node/register', true);
  assert.match(esm, /import '@feel-dev\/node\/register'/);
  assert.equal(firstImport(esm, 'server.ts', '@feel-dev/node/register', true), esm);
});

test('CLI dry-run makes no edits and ambiguous workspaces require a selection', (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.root, 'vite.config.js'), 'utf8');
  const result = spawnSync(process.execPath, [cli, '--dry-run'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('Detected React + Vite'));
  assert.equal(fs.readFileSync(path.join(f.root, 'vite.config.js'), 'utf8'), before);
  f.write('apps/other/package.json', JSON.stringify({ dependencies: { react: '^19', vite: '^7' } }));
  const ambiguous = spawnSync(process.execPath, [cli, '--yes', '--dry-run'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /--app/);
});

test('Next 15 is rejected before setup', (t) => {
  const f = fixture(t, 'next');
  f.write('package.json', JSON.stringify({ dependencies: { next: '^15.5.0', react: '^19' } }));
  assert.throws(f.plan, /Next.js 16/);
});

test('CLI applies setup without installing and repeat runs preserve files', (t) => {
  const f = fixture(t);
  const run = () => spawnSync(process.execPath, [cli, '--yes', '--no-install'], { cwd: f.root, encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const after = fs.readFileSync(path.join(f.root, 'vite.config.js'), 'utf8');
  assert.match(after, /feelPlugin\(\)/);
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(path.join(f.root, 'vite.config.js'), 'utf8'), after);
  assert.ok(!fs.existsSync(path.join(f.root, 'vite.config.js.feel-backup.1')));
  assert.ok(!fs.existsSync(path.join(f.root, 'package-lock.json')));
});

test('CLI refuses npm in a pnpm project before writing', (t) => {
  const f = fixture(t);
  f.write('pnpm-lock.yaml', 'lockfileVersion: 9');
  const before = fs.readFileSync(path.join(f.root, 'vite.config.js'), 'utf8');
  const result = spawnSync(process.execPath, [cli, '--yes'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--no-install/);
  assert.equal(fs.readFileSync(path.join(f.root, 'vite.config.js'), 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(f.root, '.gitignore')));
});

test('setup refuses paths and symlinks outside the chosen project', (t) => {
  const f = fixture(t);
  const external = fixture(t);
  assert.throws(() => safeFile(f.root, path.join(external.root, 'config.js')), /outside/);
  fs.symlinkSync(external.root, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => safeFile(f.root, path.join(f.root, 'linked', 'config.js')), /symlink/);
});

test('legacy integrations require manual migration', () => {
  assert.throws(() => configEdit("import feel from '@feel/vite-plugin'; export default { plugins: [feel()] };", 'vite.config.js', 'vite'), /Legacy/);
  assert.throws(() => firstImport("require('@feel/node/register');", 'server.cjs', '@feel-dev/node/register', true), /Legacy/);
});
