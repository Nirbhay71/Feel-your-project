import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nextMajor, serverEntry } from './detect.js';
import { configEdit, firstImport, instrumentationEdit } from './transform.js';

function within(root, file) { return file === root || file.startsWith(root + path.sep); }
export function safeFile(root, file) {
  const resolved = path.resolve(file);
  if (!within(root, resolved)) throw new Error('Planned edit is outside the selected project.');
  let existing = resolved;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  if (!within(fs.realpathSync(root), fs.realpathSync(existing))) throw new Error('Refusing to edit through a symlink outside the project.');
  return resolved;
}
function existingFile(dir, names) {
  const files = names.map((n) => path.join(dir, n)).filter((f) => fs.existsSync(f));
  if (files.length > 1) throw new Error(`Multiple matching files: ${names.join(', ')}. Select one manually.`);
  return files[0];
}

export function planSetup({ root, app, backend = null }) {
  root = fs.realpathSync(root);
  safeFile(root, app.dir);
  if (backend) safeFile(root, backend.dir);
  if (app.framework === 'next' && (nextMajor(app) ?? 0) < 16) throw new Error('Feel requires Next.js 16+. Install a supported Next version before setup.');
  const plan = { root, app, edits: [], manual: [], installs: [] };
  const relativeRoot = path.relative(app.dir, root).split(path.sep).join('/') || '.';
  const add = (file, create, transform = null) => {
    safeFile(root, file);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    try {
      const after = before === null ? create : transform ? transform(before) : before === create ? before : null;
      if (after === null) throw new Error('Existing file has different contents; merge the shown snippet manually.');
      if (before !== after) plan.edits.push({ file, before, after });
    } catch (error) { plan.manual.push({ file, message: error.message, snippet: create }); }
  };
  const install = (project, name) => {
    if (!project.deps[name]) plan.installs.push({ cwd: project.dir, packages: [name + '@^0.2.1'] });
  };

  if (app.framework === 'vite') {
    const file = existingFile(app.dir, ['vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.cjs', 'vite.config.mts', 'vite.config.cts']) ?? path.join(app.dir, 'vite.config.mjs');
    const reactPlugin = app.deps['@vitejs/plugin-react-swc'] ? '@vitejs/plugin-react-swc' : '@vitejs/plugin-react';
    if (!fs.existsSync(file) && !app.deps[reactPlugin]) throw new Error('No Vite config or React plugin found. Configure Vite for React before running setup.');
    const snippet = `import { defineConfig } from 'vite';\nimport react from '${reactPlugin}';\nexport default defineConfig({ plugins: [react()] });\n`;
    const create = configEdit(snippet, file, 'vite', relativeRoot);
    add(file, create, (code) => configEdit(code, file, 'vite', relativeRoot));
    install(app, '@feel-dev/vite-plugin');
  } else if (app.framework === 'next') {
    const file = existingFile(app.dir, ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts', 'next.config.mts']) ?? path.join(app.dir, 'next.config.mjs');
    add(file, configEdit('export default {};\n', file, 'next', relativeRoot), (code) => configEdit(code, file, 'next', relativeRoot));
    const srcApp = path.join(app.dir, 'src', 'app');
    const rootApp = path.join(app.dir, 'app');
    if (fs.existsSync(srcApp) && fs.existsSync(rootApp)) throw new Error('Both app/ and src/app/ exist; choose the App Router directory manually.');
    const appDir = fs.existsSync(srcApp) ? srcApp : fs.existsSync(rootApp) ? rootApp : null;
    if (!appDir) throw new Error('No App Router directory found. Automatic Next setup requires app/ or src/app/.');
    const base = path.dirname(appDir);
    const ext = fs.existsSync(path.join(app.dir, 'tsconfig.json')) ? 'ts' : 'js';
    const instrumentation = existingFile(base, ['instrumentation.js', 'instrumentation.ts']) ?? path.join(base, `instrumentation.${ext}`);
    const register = "export async function register() {\n  if (process.env.NODE_ENV === 'development' && process.env.NEXT_RUNTIME === 'nodejs') {\n    await import('@feel-dev/next/register');\n  }\n}\n";
    add(instrumentation, register, (code) => instrumentationEdit(code, instrumentation));
    const client = existingFile(base, ['instrumentation-client.js', 'instrumentation-client.ts']) ?? path.join(base, `instrumentation-client.${ext}`);
    add(client, "import '@feel-dev/next/client';\n", (code) => firstImport(code, client, '@feel-dev/next/client'));
    const routeDir = path.join(appDir, '%5F%5Ffeel', '[...path]');
    const route = existingFile(routeDir, ['route.js', 'route.ts']) ?? path.join(routeDir, `route.${ext}`);
    add(route, "export { GET, POST } from '@feel-dev/next/agent';\n");
    install(app, '@feel-dev/next');
  } else throw new Error('Automatic setup supports React + Vite and Next.js App Router.');

  if (backend) {
    const entry = serverEntry(backend);
    if (entry) add(entry, '', (code) => firstImport(code, entry, '@feel-dev/node/register', path.extname(entry) === '.cjs' || backend.pkg.type !== 'module' && !['.mjs', '.mts'].includes(path.extname(entry))));
    else plan.manual.push({ file: backend.dir, message: 'Could not identify the Express entry file. Put the register import first in the actual entry file.', snippet: "import '@feel-dev/node/register'; // or require('@feel-dev/node/register');" });
    install(backend, '@feel-dev/node');
  }
  if (plan.edits.some((e) => e.before !== null)) {
    const ignore = path.join(root, '.gitignore');
    add(ignore, '*.feel-backup*\n', (code) => code.includes('*.feel-backup*') ? code : code.trimEnd() + '\n*.feel-backup*\n');
  }
  return plan;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.feel-tmp-${randomUUID()}`;
  try { fs.writeFileSync(temporary, content, { flag: 'wx', mode: fs.existsSync(file) ? fs.statSync(file).mode : 0o666 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function applyPlan(plan) {
  for (const edit of plan.edits) {
    safeFile(plan.root, edit.file);
    const current = fs.existsSync(edit.file) ? fs.readFileSync(edit.file, 'utf8') : null;
    if (current !== edit.before) throw new Error(`File changed after preview: ${path.relative(plan.root, edit.file)}. Run setup again.`);
  }
  const written = [];
  try {
    for (const edit of plan.edits) {
      if (edit.before !== null) {
        let backup = edit.file + '.feel-backup', n = 1;
        while (fs.existsSync(backup)) backup = edit.file + '.feel-backup.' + n++;
        fs.writeFileSync(backup, edit.before, { flag: 'wx' });
      }
      atomicWrite(edit.file, edit.after);
      written.push(edit);
    }
  } catch (error) {
    for (const edit of written.reverse()) {
      if (edit.before === null) fs.unlinkSync(edit.file);
      else atomicWrite(edit.file, edit.before);
    }
    throw error;
  }
}
