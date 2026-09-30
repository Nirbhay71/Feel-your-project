// Which backend route a static "possible call" lands on (static.js's
// matchRoute): the most specific one wins, catch-alls last, and a URL built
// on an unknown (maybe empty) base still finds its route. Small apps are
// written to a temp folder so each case shows its whole setup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { possibleCalls } from '../packages/agent/src/static.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feel-match-'));

function writeApp(name, files) {
  const dir = path.join(TMP, name);
  for (const [rel, code] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), code);
  }
  return dir;
}

// "METHOD url → METHOD route path (file)" for each call the component makes.
async function routesFor(dir, file, component) {
  const calls = await possibleCalls({ abs: path.join(dir, file), component, rootDir: dir, display: (f) => path.relative(dir, f) });
  return calls.map((c) => `${c.method} ${c.url} → ${c.route ? `${c.route.method} ${c.route.path}` : 'none'}`).sort();
}

const COMPONENT = `export default function Users({ id }) {
  const BASE = import.meta.env.VITE_API ?? '';
  return <button onClick={() => { fetch('/api/users/' + id); fetch(\`\${BASE}/api/shared\`); }}>go</button>;
}
`;

test('Express: app.get("*") (the SPA fallback) never wins over a real route', async () => {
  const dir = writeApp('spa', {
    'client/Users.jsx': COMPONENT,
    'server/app.js': `const express = require('express');
const app = express();
app.get('*', (req, res) => res.sendFile('index.html'));
app.get('/api/users/:id', (req, res) => res.json({}));
app.get('/api/shared', (req, res) => res.json({}));
`,
  });
  assert.deepEqual(await routesFor(dir, 'client/Users.jsx', 'Users'), [
    'GET */api/shared → GET /api/shared',
    'GET /api/users/* → GET /api/users/:id',
  ]);
});

test('Next: [id] beats [...slug]; a base that may be empty still matches', async () => {
  const dir = writeApp('next', {
    'next.config.mjs': 'export default {};\n',
    'components/Users.jsx': COMPONENT,
    'app/api/users/[...slug]/route.js': 'export function GET() {}\n',
    'app/api/users/[id]/route.js': 'export function GET() {}\n',
    'app/api/shared/route.js': 'export function GET() {}\n',
  });
  assert.deepEqual(await routesFor(dir, 'components/Users.jsx', 'Users'), [
    'GET */api/shared → GET /api/shared',
    'GET /api/users/* → GET /api/users/:id',
  ]);
});

test('Express: the catch-all still answers what nothing else does', async () => {
  const dir = writeApp('fallback', {
    'client/Page.jsx': "export default function Page() {\n  fetch('/about/team');\n  return null;\n}\n",
    'server/app.js': "const express = require('express');\nconst app = express();\napp.get('/api/users/:id', h);\napp.get('*', h);\nfunction h() {}\n",
  });
  assert.deepEqual(await routesFor(dir, 'client/Page.jsx', 'Page'), ['GET /about/team → GET /*']);
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
