// Piece 1 — Vite plugin (dev only).
//
// For every .jsx/.tsx file in the user's project:
//   1. parse it into an AST with @babel/parser
//   2. walk every JSX opening tag with @babel/traverse
//   3. for lowercase (real DOM) tags, find line:col and the enclosing component name
//   4. insert  data-src="src/File.jsx:42:5|Component"  with magic-string
//
// It also injects the browser script (Piece 2) that reads these attributes
// on Alt + right-click, and mounts the agent (Piece 3) that serves source code,
// maps stack traces and builds the static call graph.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MagicString from 'magic-string';
import { parseCode, traverse, findComponent, functionName, createAgent, AGENT_ROUTE } from '@feel/agent';

const ATTR = 'data-src';
const JSX_FILE = /\.(jsx|tsx)$/;

// The browser script (Piece 2) is served under this URL.
const CLIENT_URL = '/@feel/client';
const CLIENT_FILE = fileURLToPath(import.meta.resolve('@feel/client'));

// options.database:    Postgres connection string, so the panel can show table
//                      structure and changes (Layer 3). Optional.
// options.projectRoot: folder holding frontend *and* backend, if the nearest
//                      .git above Vite's root isn't it. Optional.
export default function feel(options = {}) {
  let root = process.cwd();
  let aliases = [];

  return {
    name: 'feel',
    apply: 'serve', // never runs in production builds
    enforce: 'pre', // see the raw JSX before React's own transform

    // Pre-bundle Shiki (the panel's highlighter, a dependency of @feel/client)
    // up front; otherwise Vite discovers it on first use and reloads the page.
    config() {
      return { optimizeDeps: { include: ['@feel/client > shiki'] } };
    },

    configResolved(config) {
      root = config.root;
      aliases = config.resolve.alias; // normalised by Vite to [{ find, replacement }]
    },

    // Mount the agent at /__feel. It gets access to Vite's module graph so it
    // can map browser stack traces back to original lines via sourcemaps.
    configureServer(server) {
      const getModule = async (url) => {
        const mod = await server.moduleGraph.getModuleByUrl(url);
        return mod && { file: mod.file, map: mod.transformResult?.map };
      };
      server.middlewares.use(AGENT_ROUTE, createAgent({ root, projectRoot: options.projectRoot, getModule, database: options.database, aliases }));
    },

    // Add <script type="module" src="/@feel/client"> at the very top of <head>,
    // so it runs before the app and can wrap fetch before any request is made...
    transformIndexHtml() {
      return [{ tag: 'script', attrs: { type: 'module', src: CLIENT_URL }, injectTo: 'head-prepend' }];
    },

    // ...and when the browser asks for that URL, serve the client file.
    resolveId(id) {
      if (id === CLIENT_URL) return CLIENT_FILE;
    },

    transform(code, id) {
      // Vite ids can carry queries like "?v=123"; strip them.
      const file = id.split('?')[0];
      if (!JSX_FILE.test(file) || file.includes('node_modules')) return null;

      const ast = parseCode(code, file);

      // Path relative to the Vite root, always with forward slashes.
      const relFile = path.relative(root, file).split(path.sep).join('/');
      const s = new MagicString(code);

      traverse(ast, {
        JSXOpeningElement(p) {
          const { node } = p;
          if (!isDomTag(node.name)) return;
          if (node.attributes.some((a) => a.name?.name === ATTR)) return;

          const { line, column } = node.loc.start;
          const fn = findComponent(p);
          const component = fn ? functionName(fn) : path.basename(file).replace(JSX_FILE, '');
          const value = `${relFile}:${line}:${column + 1}|${component}`;

          // Insert right after the tag name:  <div|  →  <div data-src="…"
          s.appendLeft(node.name.end, ` ${ATTR}="${escapeAttr(value)}"`);
        },
      });

      // Tag each component function with where it's defined:
      //   Notifications.__feelSrc = "src/components/Notifications.jsx:3|Notifications"
      // The client finds it on React's fiber tree (fiber.type), which tells
      // your components apart from library ones (Recharts, MUI, …).
      const components = topLevelComponents(ast);
      if (components.length) {
        const list = components.map(({ name, line }) => `[${name}, ${JSON.stringify(`${relFile}:${line}|${name}`)}]`);
        s.append(
          `\n;[${list.join(', ')}].forEach(([c, src]) => { try { Object.defineProperty(c, '__feelSrc', { value: src, configurable: true }); } catch {} });\n`,
        );
      }

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
