// Piece 1 — Vite plugin (dev only).
//
// For every .jsx/.tsx file in the user's project:
//   1. parse it into an AST with @babel/parser
//   2. walk every JSX opening tag with @babel/traverse
//   3. for lowercase (real DOM) tags, find line:col and the enclosing component name
//   4. insert  data-src="src/File.jsx:42:5|Component"  with magic-string
//
// The browser script (Piece 2) later reads these attributes on right-click.

import path from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import MagicString from 'magic-string';

// @babel/traverse is CommonJS; under ESM the function sits on .default.
const traverse = _traverse.default ?? _traverse;

const ATTR = 'data-src';
const JSX_FILE = /\.(jsx|tsx)$/;

export default function feel() {
  let root = process.cwd();

  return {
    name: 'feel',
    apply: 'serve', // never runs in production builds
    enforce: 'pre', // see the raw JSX before React's own transform

    configResolved(config) {
      root = config.root;
    },

    transform(code, id) {
      // Vite ids can carry queries like "?v=123"; strip them.
      const file = id.split('?')[0];
      if (!JSX_FILE.test(file) || file.includes('node_modules')) return null;

      const ast = parse(code, {
        sourceType: 'module',
        plugins: file.endsWith('.tsx') ? ['jsx', 'typescript'] : ['jsx'],
      });

      // Path relative to the Vite root, always with forward slashes.
      const relFile = path.relative(root, file).split(path.sep).join('/');
      const s = new MagicString(code);

      traverse(ast, {
        JSXOpeningElement(p) {
          const { node } = p;
          if (!isDomTag(node.name)) return;
          if (node.attributes.some((a) => a.name?.name === ATTR)) return;

          const { line, column } = node.loc.start;
          const component = getComponentName(p) ?? path.basename(file).replace(JSX_FILE, '');
          const value = `${relFile}:${line}:${column + 1}|${component}`;

          // Insert right after the tag name:  <div|  →  <div data-src="…"
          s.appendLeft(node.name.end, ` ${ATTR}="${escapeAttr(value)}"`);
        },
      });

      if (!s.hasChanged()) return null;
      return { code: s.toString(), map: s.generateMap({ hires: true, source: file }) };
    },
  };
}

// Lowercase identifiers (<div>, <svg>) become real DOM elements.
// Components (<Chart>), member tags (<motion.div>) and namespaced tags are skipped.
function isDomTag(name) {
  return name.type === 'JSXIdentifier' && /^[a-z]/.test(name.name);
}

// Walk up from the JSX tag to the nearest function that looks like a component:
//   function Chart() {}            → "Chart"
//   const Chart = () => {}         → "Chart"
//   const Chart = memo(() => {})   → "Chart"
// Lowercase or anonymous functions (e.g. a .map callback) are skipped.
function getComponentName(p) {
  let fn = p.getFunctionParent();
  while (fn) {
    const name = functionName(fn);
    if (name && /^[A-Z]/.test(name)) return name;
    fn = fn.getFunctionParent();
  }
  return null;
}

function functionName(fn) {
  if (fn.node.id?.name) return fn.node.id.name;

  // Climb through wrapper calls like memo(...) / forwardRef(...).
  let parent = fn.parentPath;
  while (parent?.isCallExpression()) parent = parent.parentPath;

  if (parent?.isVariableDeclarator() && parent.node.id.type === 'Identifier') {
    return parent.node.id.name;
  }
  return null;
}

function escapeAttr(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
