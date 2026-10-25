// Report capabilities without returning credentials, environment values or
// source contents. The optional database probe is a read-only SELECT 1.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

function manifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return {}; }
}
function installed(dir, name) {
  try {
    const file = createRequire(path.join(dir, 'package.json')).resolve(name + '/package.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).version;
  } catch { return null; }
}
function metadata(root, projectRoot) {
  const directories = new Set([root, projectRoot]);
  for (const folder of ['server', 'backend', 'api', 'client', 'frontend']) {
    const dir = path.join(projectRoot, folder);
    if (fs.existsSync(dir) && fs.realpathSync(dir).startsWith(projectRoot + path.sep)) directories.add(dir);
  }
  for (const folder of ['apps', 'packages']) {
    const base = path.join(projectRoot, folder);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) directories.add(path.join(base, entry.name));
  }
  return [...directories].map(manifest).map((pkg) => ({ ...pkg.devDependencies, ...pkg.dependencies }));
}

export async function diagnose({ root, projectRoot, configured, mysql, probe }) {
  const checks = [{ id: 'agent', label: 'Feel agent', status: 'ok', message: 'The browser can reach the development agent.' }];
  const pkg = manifest(root);
  const deps = { ...pkg.devDependencies, ...pkg.dependencies };
  const react = installed(root, 'react');
  const next = installed(root, 'next');
  checks.push({ id: 'frontend', label: 'Frontend', status: react && Number(react.split('.')[0]) >= 19 ? 'ok' : 'warning', message: react ? `React ${react}${next ? ` on Next.js ${next}` : deps.vite ? ' on Vite' : ''}. ${Number(react.split('.')[0]) < 19 ? 'React 18 and older use a simpler DOM-based component chain.' : 'Component inspection is available.'}` : 'React version could not be verified. Check the app installation.' });
  const packages = metadata(root, projectRoot);
  const prisma = packages.find((d) => d['@prisma/client']);
  if (prisma) {
    const version = installed(root, '@prisma/client') ?? prisma['@prisma/client'];
    const major = Number(String(version).match(/\d+/)?.[0]);
    const adapter = packages.some((d) => d['@prisma/adapter-pg']);
    checks.push({ id: 'prisma', label: 'Prisma SQL capture', status: major < 7 && !adapter ? 'warning' : 'unknown', message: major < 7 && !adapter ? 'Prisma 6 and older using the Rust engine bypass pg. Use a supported Postgres driver adapter, or expect component/API tracing without runtime SQL.' : 'Check observed SQL to verify capture. Declaring an adapter package alone does not prove that the app uses it.' });
  }
  if (!configured) checks.push({ id: 'database', label: 'Table inspection', status: 'optional', message: 'No database configured. Component, API and instrumented SQL tracing work without a table-view connection. Pass the database option to enable table details.' });
  else if (mysql) checks.push({ id: 'database', label: 'Table inspection', status: 'warning', message: 'MySQL query capture is supported; table structure inspection currently requires Postgres.' });
  else {
    try {
      await probe();
      checks.push({ id: 'database', label: 'Table inspection', status: 'ok', message: 'Postgres connection succeeded. Table access still depends on this database user’s permissions.' });
    } catch {
      checks.push({ id: 'database', label: 'Table inspection', status: 'error', message: 'Could not connect to Postgres. Check the database option, credentials and whether your development database is running.' });
    }
  }
  return { checks };
}
