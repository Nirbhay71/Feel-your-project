#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { discover } from '../src/detect.js';
import { planSetup, applyPlan } from '../src/setup.js';

const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const root = fs.realpathSync(process.cwd());
let input;
async function ask(question) {
  if (!process.stdin.isTTY) throw new Error('Interactive input is unavailable. Use --app, --backend and --yes with --dry-run first.');
  input ??= createInterface({ input: process.stdin, output: process.stdout });
  return input.question(question);
}
async function choose(projects, requested, label) {
  if (requested) {
    const selected = path.resolve(root, requested);
    const match = projects.find((p) => p.dir === (fs.existsSync(selected) ? fs.realpathSync(selected) : selected));
    if (!match) throw new Error(`No supported ${label} package at ${requested}.`);
    return match;
  }
  if (projects.length === 1) return projects[0];
  if (!projects.length) return null;
  projects.forEach((p, i) => console.log(`  ${i + 1}. ${path.relative(root, p.dir) || '.'} (${p.framework ?? 'Express'})`));
  const selected = Number(await ask(`Choose ${label} [1-${projects.length}]: `));
  if (!Number.isInteger(selected) || selected < 1 || selected > projects.length) throw new Error('Invalid selection.');
  return projects[selected - 1];
}
try {
  for (let i = 0; i < args.length; i++) {
    if (['--app', '--backend'].includes(args[i])) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${args[i]} needs a package path.`);
      i++;
    } else if (!['--help', '--dry-run', '--no-install', '--yes', '--no-backend'].includes(args[i])) throw new Error(`Unknown option: ${args[i]}`);
  }
  if (args.includes('--backend') && args.includes('--no-backend')) throw new Error('Choose --backend or --no-backend, not both.');
  if (args.includes('--help')) {
    console.log('Usage: npx @feel-dev/init [--app path] [--backend path | --no-backend] [--dry-run] [--no-install] [--yes]\nRun from the app or workspace root. Setup previews edits and installation commands before asking for confirmation.');
  } else {
    const projects = discover(root);
    const app = await choose(projects.filter((p) => p.framework), option('--app'), 'frontend');
    if (!app) throw new Error('No React + Vite or Next.js app found. Run from your app or workspace root.');
    const backend = args.includes('--no-backend') ? null : await choose(projects.filter((p) => p.express), option('--backend'), 'backend');
    const plan = planSetup({ root, app, backend });
    const manager = [app.dir, root].map((dir) => {
      let declared = '';
      try { declared = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).packageManager ?? ''; } catch { /* no root manifest */ }
      return /^(pnpm|yarn|bun)@/.exec(declared)?.[1] ?? (fs.existsSync(path.join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(dir, 'yarn.lock')) ? 'yarn' : fs.existsSync(path.join(dir, 'bun.lock')) || fs.existsSync(path.join(dir, 'bun.lockb')) ? 'bun' : null);
    }).find(Boolean) ?? 'npm';
    console.log(`\nDetected ${app.framework === 'next' ? 'Next.js' : 'React + Vite'} in ${path.relative(root, app.dir) || '.'}`);
    for (const e of plan.edits) console.log(`${e.before === null ? 'Create' : 'Update (with backup)'} ${path.relative(root, e.file)}`);
    for (const item of plan.installs) console.log(`Install in ${path.relative(root, item.cwd) || '.'}: ${item.packages.join(' ')}`);
    for (const item of plan.manual) console.log(`\nManual step: ${path.relative(root, item.file)}\n${item.message}\n${item.snippet}`);
    if (!args.includes('--dry-run')) {
      if (manager !== 'npm' && !args.includes('--no-install')) throw new Error(`${manager} project detected. Run again with --no-install, then install the listed packages using ${manager}; no files were changed.`);
      const approved = args.includes('--yes') || /^y(?:es)?$/i.test((await ask('Apply the listed edits and installs? [y/N] ')).trim());
      if (approved) {
        applyPlan(plan);
        if (!args.includes('--no-install')) for (const item of plan.installs) {
          // Invoke npm's JS CLI directly when available; never interpolate user
          // paths or arguments into a shell command on Windows.
          const npm = process.env.npm_execpath;
          const result = npm && /npm-cli\.js$/.test(npm)
            ? spawnSync(process.execPath, [npm, 'install', '--save-dev', ...item.packages], { cwd: item.cwd, stdio: 'inherit' })
            : process.platform === 'win32' ? null : spawnSync('npm', ['install', '--save-dev', ...item.packages], { cwd: item.cwd, stdio: 'inherit' });
          if (!result || result.status !== 0) throw new Error(`Edits were saved with backups. Install manually in ${path.relative(root, item.cwd) || '.'}: npm install -D ${item.packages.join(' ')}`);
        }
        console.log('\nSetup edits complete. Restart your dev server, Alt + right-click a component, then open Setup checks. Database inspection is optional; configure database in Feel only if needed.');
        if (plan.manual.length) console.log('Finish the manual steps above before expecting the full trace.');
        if (plan.manual.length) process.exitCode = 2;
      } else console.log('No changes made.');
    }
  }
} catch (error) { console.error(`Feel setup: ${error.message}`); process.exitCode = 1; }
finally { input?.close(); }
