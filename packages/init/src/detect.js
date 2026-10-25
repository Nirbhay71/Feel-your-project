// Inspect manifests only. Never run project code or read environment files.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo']);
export function discover(root, depth = 4) {
  const projects = [];
  function visit(dir, remaining) {
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* not a package */ }
    if (pkg) {
      const deps = { ...pkg.devDependencies, ...pkg.dependencies };
      const framework = deps.next ? 'next' : deps.react && deps.vite ? 'vite' : null;
      if (framework || deps.express) projects.push({ dir, pkg, deps, framework, express: !!deps.express });
    }
    if (!remaining) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name)) visit(path.join(dir, entry.name), remaining - 1);
    }
  }
  visit(fs.realpathSync(root), depth);
  return projects;
}

export function nextMajor(project) {
  try {
    const file = createRequire(path.join(project.dir, 'package.json')).resolve('next/package.json');
    return Number(JSON.parse(fs.readFileSync(file, 'utf8')).version.split('.')[0]);
  } catch {
    const match = String(project.deps.next ?? '').match(/^[~^]?(\d+)(?:\.|$)/);
    return match ? Number(match[1]) : null;
  }
}

export function serverEntry(project) {
  const candidates = [];
  for (const script of [project.pkg.scripts?.start, project.pkg.scripts?.dev]) {
    if (script && /^(?:node|nodemon|tsx|ts-node)\s/.test(script)) {
      candidates.push(script.match(/(?:^|\s)([\w./-]+\.(?:[cm]?js|ts))(?:\s|$)/)?.[1]);
    }
  }
  candidates.push(project.pkg.main);
  return candidates.filter(Boolean).map((p) => path.resolve(project.dir, p)).find((p) => p.startsWith(project.dir + path.sep) && fs.existsSync(p)) ?? null;
}
