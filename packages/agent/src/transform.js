// The JSX tagging shared by the Vite plugin and the Next.js loader.
//
// For every lowercase (real DOM) JSX tag it inserts where it was written:
//   <li>  →  <li data-src="components/ItemList.jsx:12:9|ItemList">
// and after the code it tags each top-level component with where it's
// defined (Component.__feelSrc), so the browser can tell your components
// apart from library ones on React's fiber tree.
//
// Everything is inserted *inside* existing lines or appended after the last
// one, so no original line moves. Next's Turbopack reads a loader's output as
// if it were the file you wrote; keeping lines in place means stack traces
// still point at the right line even if a sourcemap gets lost on the way.

import path from 'node:path';
import MagicString from 'magic-string';
import { parseCode, traverse, findComponent, functionName } from './ast.js';

const ATTR = 'data-src';

// file:        absolute path of the module
// root:        paths in the tags are relative to it (Vite's root / Next's root)
// requireJsx:  for .js files that may or may not hold JSX — tag components
//              only when the file actually renders something, so a plain
//              module with a capitalised class isn't mistaken for one.
// Returns { code, map } or null when nothing changed. Throws on a syntax
// error — callers pass the code through untouched then.
export function tagJsx(code, file, { root, requireJsx = false }) {
  const ast = parseCode(code, file);

  // Path relative to the root, always with forward slashes.
  const relFile = path.relative(root, file).split(path.sep).join('/');
  const fallbackName = path.basename(file).replace(/\.[^.]+$/, '');
  const s = new MagicString(code);
  let sawJsx = false;

  traverse(ast, {
    JSXFragment() {
      sawJsx = true;
    },
    JSXOpeningElement(p) {
      sawJsx = true;
      const { node } = p;
      if (!isDomTag(node.name)) return;
      if (node.attributes.some((a) => a.name?.name === ATTR)) return;

      const { line, column } = node.loc.start;
      const fn = findComponent(p);
      const component = fn ? functionName(fn) : fallbackName;
      const value = `${relFile}:${line}:${column + 1}|${component}`;

      // Insert right after the tag name:  <div|  →  <div data-src="…"
      s.appendLeft(node.name.end, ` ${ATTR}="${escapeAttr(value)}"`);
    },
  });

  // Tag each component function with where it's defined:
  //   Notifications.__feelSrc = "src/components/Notifications.jsx:3|Notifications"
  // The client finds it on React's fiber tree (fiber.type), which tells
  // your components apart from library ones (Recharts, MUI, …).
  const components = requireJsx && !sawJsx ? [] : topLevelComponents(ast);
  if (components.length) {
    const list = components.map(({ name, line }) => `[${name}, ${JSON.stringify(`${relFile}:${line}|${name}`)}]`);
    s.append(
      `\n;[${list.join(', ')}].forEach(([c, src]) => { try { Object.defineProperty(c, '__feelSrc', { value: src, configurable: true }); } catch {} });\n`,
    );
  }

  if (!s.hasChanged()) return null;
  return { code: s.toString(), map: s.generateMap({ hires: true, source: file }) };
}

// Lowercase identifiers (<div>, <svg>) become real DOM elements.
// Components (<Chart>), member tags (<motion.div>) and namespaced tags are skipped.
function isDomTag(name) {
  return name.type === 'JSXIdentifier' && /^[a-z]/.test(name.name);
}

// Capitalized top-level functions/classes, and capitalized consts that hold a
// function or a wrapped one (memo(...), forwardRef(...)).
//   function Chart() {}          export default function Dashboard() {}
//   const Card = () => …         const Row = memo(function Row() { … })
// Anonymous default exports have no name to tag, so they're skipped.
function topLevelComponents(ast) {
  const out = [];
  const isComponentName = (name) => /^[A-Z]/.test(name ?? '');
  const wrapsFunction = (init) =>
    init &&
    (init.type === 'ArrowFunctionExpression' ||
      init.type === 'FunctionExpression' ||
      init.type === 'ClassExpression' ||
      (init.type === 'CallExpression' && init.arguments.some((a) => /Function|Call/.test(a.type))));

  for (let stmt of ast.program.body) {
    if (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') stmt = stmt.declaration;
    if (!stmt) continue;

    if ((stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') && isComponentName(stmt.id?.name)) {
      out.push({ name: stmt.id.name, line: stmt.loc.start.line });
    } else if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) {
        if (d.id.type === 'Identifier' && isComponentName(d.id.name) && wrapsFunction(d.init)) {
          out.push({ name: d.id.name, line: d.loc.start.line });
        }
      }
    }
  }
  return out;
}

function escapeAttr(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
