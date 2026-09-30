// Piece 1 — Vite plugin (dev only).
//
// For every .jsx/.tsx file in the user's project:
//   1. parse it into an AST with @babel/parser
//   2. walk every JSX opening tag with @babel/traverse
//   3. for lowercase (real DOM) tags, find line:col and the enclosing component name
//   4. insert  data-src="src/File.jsx:42:5|Component"  with magic-string
// (steps 1–4 live in @feel-dev/agent's transform.js, shared with @feel-dev/next)
//
// It also injects the browser script (Piece 2) that reads these attributes
// on Alt + right-click, and mounts the agent (Piece 3) that serves source code,
// maps stack traces and builds the static call graph.

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tagJsx, createAgent, AGENT_ROUTE } from '@feel-dev/agent';

const JSX_FILE = /\.(jsx|tsx)$/;

// The browser script (Piece 2) is served under this URL.
const CLIENT_URL = '/@feel-dev/client';
const CLIENT_FILE = fileURLToPath(import.meta.resolve('@feel-dev/client'));

// Only for apps that use axios: a tiny module that patches the app's own axios
// (see @feel-dev/client/src/axios.js). Virtual, so apps without axios never try to
// import it.
const AXIOS_URL = '/@feel-dev/axios';
const AXIOS_ID = '\0feel-axios';
const AXIOS_PATCH_FILE = path.join(path.dirname(CLIENT_FILE), 'axios.js').split(path.sep).join('/');

// options.database:    Postgres connection string, so the panel can show table
//                      structure and changes (Layer 3). Optional. MySQL URLs
//                      are accepted, but the table view is Postgres-only.
// options.projectRoot: folder holding frontend *and* backend, if the nearest
//                      .git above Vite's root isn't it. Optional.
export default function feel(options = {}) {
  let root = process.cwd();
  let aliases = [];
  let hasAxios = false;

  return {
    name: 'feel',
    apply: 'serve', // never runs in production builds
    enforce: 'pre', // see the raw JSX before React's own transform

    // Pre-bundle Shiki (the panel's highlighter, a dependency of @feel-dev/client)
    // up front; otherwise Vite discovers it on first use and reloads the page.
    config() {
      return { optimizeDeps: { include: ['@feel-dev/client > shiki'] } };
    },

    configResolved(config) {
      root = config.root;
      aliases = config.resolve.alias; // normalised by Vite to [{ find, replacement }]
      try {
        createRequire(path.join(root, 'package.json')).resolve('axios');
        hasAxios = true;
      } catch {
        hasAxios = false;
      }
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

    // Add <script type="module" src="/@feel-dev/client"> at the very top of <head>,
    // so it runs before the app and can wrap fetch before any request is made...
    transformIndexHtml() {
      const tags = [{ tag: 'script', attrs: { type: 'module', src: CLIENT_URL }, injectTo: 'head-prepend' }];
      if (hasAxios) tags.push({ tag: 'script', attrs: { type: 'module', src: AXIOS_URL }, injectTo: 'head-prepend' });
      return tags;
    },

    // ...and when the browser asks for those URLs, serve the client file /
    // the axios patch (which imports the *app's* axios, so it's the same copy).
    resolveId(id) {
      if (id === CLIENT_URL) return CLIENT_FILE;
      if (id === AXIOS_URL) return AXIOS_ID;
    },
    load(id) {
      if (id === AXIOS_ID) {
        return `import axios from 'axios';\nimport { patchAxios } from ${JSON.stringify(AXIOS_PATCH_FILE)};\npatchAxios(axios);\n`;
      }
    },

    // Tag every DOM element with where it was written (see @feel-dev/agent's
    // transform.js — the Next.js loader uses the same function).
    transform(code, id) {
      // Vite ids can carry queries like "?v=123"; strip them.
      const file = id.split('?')[0];
      if (!JSX_FILE.test(file) || file.includes('node_modules')) return null;
      return tagJsx(code, file, { root });
    },
  };
}
