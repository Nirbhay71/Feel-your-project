// Import resolution: from an import specifier to a file on disk.
//
//   './api.js'            relative                 → next to the importing file
//   '@/api.js'            Vite resolve.alias       → src/api.js
//   '@/api.js'            tsconfig/jsconfig paths  → src/api.js   (when not running in Vite)
//   '#db'                 package.json "imports"   → server/db.js (Node subpath imports)
//   'components/Card'     tsconfig baseUrl         → src/components/Card.jsx
//   'react'               a package                → null (not followed)
//
// Tried in that order; the first one that points at an existing file wins.

import fs from 'node:fs';
import path from 'node:path';

const EXTENSIONS = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '/index.js', '/index.jsx', '/index.ts', '/index.tsx'];

export function resolveImport(fromAbs, specifier) {
  if (specifier.startsWith('.')) return tryFile(path.resolve(path.dirname(fromAbs), specifier));
  return viaViteAlias(specifier) ?? viaTsconfig(fromAbs, specifier) ?? viaPackageImports(fromAbs, specifier);
}

// base, base.js, base.jsx, …, base/index.js — the first that exists.
function tryFile(base) {
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // doesn't exist — try the next one
    }
  }
  return null;
}

// --- Vite resolve.alias --------------------------------------------------------

// Set by the Vite plugin from the resolved config: [{ find, replacement }],
// where find is a string or a RegExp — the same shape and rules Vite uses.
let viteAliases = [];
let viteRoot = process.cwd();

export function setViteAliases(aliases, root) {
  viteAliases = Array.isArray(aliases) ? aliases : [];
  viteRoot = root;
}

function viaViteAlias(specifier) {
  for (const { find, replacement } of viteAliases) {
    let mapped = null;
    if (typeof find === 'string') {
      // Like Vite: "@" matches "@" and "@/…", but not "@tanstack/…".
      if (specifier === find || specifier.startsWith(`${find}/`)) mapped = replacement + specifier.slice(find.length);
    } else if (find instanceof RegExp && find.test(specifier)) {
      mapped = specifier.replace(find, replacement);
    }
    if (mapped == null) continue;
    // "/src/x" in Vite means "<root>/src/x" unless it's already a real path on disk.
    const abs = path.isAbsolute(mapped) && fs.existsSync(path.dirname(mapped)) ? mapped : path.resolve(viteRoot, mapped.replace(/^\//, ''));
    return tryFile(abs); // Vite uses the first matching alias only
  }
  return null;
}

// --- tsconfig.json / jsconfig.json -------------------------------------------------

const tsconfigByDir = new Map(); // dir → config | null (cached; restart after editing tsconfig)

// { "paths": { "@/*": ["./src/*"] }, "baseUrl": "." }
function viaTsconfig(fromAbs, specifier) {
  const config = nearestTsconfig(path.dirname(fromAbs));
  if (!config) return null;

  if (config.paths) {
    // Longest matching prefix wins, like TypeScript.
    const patterns = Object.keys(config.paths).sort((a, b) => b.split('*')[0].length - a.split('*')[0].length);
    for (const pattern of patterns) {
      const star = matchPattern(pattern, specifier);
      if (star == null) continue;
      for (const target of config.paths[pattern]) {
        const found = tryFile(path.resolve(config.pathsBase, target.replace('*', star)));
        if (found) return found;
      }
    }
  }
  // baseUrl alone: bare imports like 'components/Card' resolve from it.
  return config.baseUrl ? tryFile(path.resolve(config.baseUrl, specifier)) : null;
}

function nearestTsconfig(dir) {
  if (tsconfigByDir.has(dir)) return tsconfigByDir.get(dir);
  let config = null;
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) {
      config = readTsconfig(file);
      break;
    }
  }
  const parent = path.dirname(dir);
  if (!config && parent !== dir && !fs.existsSync(path.join(dir, 'package.json'))) config = nearestTsconfig(parent);
  tsconfigByDir.set(dir, config);
  return config;
}

// → { baseUrl, paths, pathsBase } following "extends" and, if the file itself
// has no paths, its project "references" (Vite's TS template keeps paths in
// tsconfig.app.json, referenced from tsconfig.json).
function readTsconfig(file, seen = new Set()) {
  if (seen.has(file) || !fs.existsSync(file)) return {};
  seen.add(file);
  let json;
  try {
    json = parseJsonc(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  const dir = path.dirname(file);
  const withJson = (p) => (p.endsWith('.json') ? p : `${p}.json`);

  const base = typeof json.extends === 'string' && json.extends.startsWith('.') ? readTsconfig(withJson(path.resolve(dir, json.extends)), seen) : {};
  const options = json.compilerOptions ?? {};
  const baseUrl = options.baseUrl ? path.resolve(dir, options.baseUrl) : base.baseUrl;
  const result = options.paths
    ? { baseUrl, paths: options.paths, pathsBase: baseUrl ?? dir } // paths are relative to baseUrl, or to this file
    : { baseUrl, paths: base.paths, pathsBase: base.pathsBase };

  if (!result.paths) {
    for (const ref of json.references ?? []) {
      const refPath = path.resolve(dir, ref.path);
      const refConfig = readTsconfig(fs.existsSync(refPath) && fs.statSync(refPath).isDirectory() ? path.join(refPath, 'tsconfig.json') : withJson(refPath), seen);
      if (refConfig.paths) return { ...refConfig, baseUrl: result.baseUrl ?? refConfig.baseUrl };
    }
  }
  return result;
}

// tsconfig files allow comments and trailing commas; JSON.parse doesn't.
function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// --- package.json "imports" (Node subpath imports) ---------------------------------

const packageByDir = new Map(); // dir → { dir, imports } | null

// { "imports": { "#db": "./server/db.js", "#services/*": "./server/services/*.js" } }
function viaPackageImports(fromAbs, specifier) {
  if (!specifier.startsWith('#')) return null;
  const pkg = nearestPackage(path.dirname(fromAbs));
  if (!pkg?.imports) return null;

  for (const [pattern, value] of Object.entries(pkg.imports)) {
    const star = matchPattern(pattern, specifier);
    if (star == null) continue;
    const target = conditionTarget(value);
    if (target) return tryFile(path.resolve(pkg.dir, target.replace('*', star)));
  }
  return null;
}

// Node uses the nearest package.json, whether or not it has "imports".
function nearestPackage(dir) {
  if (packageByDir.has(dir)) return packageByDir.get(dir);
  const file = path.join(dir, 'package.json');
  let pkg = null;
  if (fs.existsSync(file)) {
    try {
      pkg = { dir, imports: JSON.parse(fs.readFileSync(file, 'utf8')).imports };
    } catch {
      pkg = { dir, imports: null };
    }
  } else if (path.dirname(dir) !== dir) {
    pkg = nearestPackage(path.dirname(dir));
  }
  packageByDir.set(dir, pkg);
  return pkg;
}

// "./x.js"  or  { "node": "./x.js", "default": "./y.js" }  → a path string.
function conditionTarget(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  for (const key of ['import', 'node', 'default']) if (key in value) return conditionTarget(value[key]);
  return conditionTarget(Object.values(value)[0]);
}

// --- Shared ------------------------------------------------------------------------

// "@/*" vs "@/api.js" → "api.js"; exact patterns → ""; no match → null.
function matchPattern(pattern, specifier) {
  const i = pattern.indexOf('*');
  if (i === -1) return pattern === specifier ? '' : null;
  const prefix = pattern.slice(0, i);
  const suffix = pattern.slice(i + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix) || specifier.length < prefix.length + suffix.length) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}
