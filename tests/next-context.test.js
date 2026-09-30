// Query call sites under `next dev` (@feel-dev/node's context.js): route
// handlers run from a bundle, so the stack frame that sent a query points
// into it — Turbopack's .next/dev/server/chunks/….js, or webpack's eval'd
// webpack-internal:///(rsc)/./lib/db.js. callerSite() maps it back to your file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import MagicString from 'magic-string';
import { callerSite } from '../packages/node/src/context.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feel-next-ctx-'));
const DB_FILE = path.join(TMP, 'lib', 'db.js');
const PG_FILE = path.join(TMP, 'node_modules', 'pg', 'lib', 'client.js');

// A map for `code` placed `shift` lines down in the bundle.
function mapOf(code, source, shift = 0) {
  const s = new MagicString(code);
  if (shift) s.prepend('\n'.repeat(shift));
  return s.generateMap({ hires: true, source });
}

test('Turbopack chunk: the .js.map next to it (sectioned) leads back to your file', () => {
  const user = '// db\nexport function query(cs) {\n  return cs();\n}\n';
  const lib = 'function send(cs) {\n  return cs();\n}\n';
  // The chunk: our user module on lines 1–4 (its line 3 is chunk line 3),
  // then a library module from line 11 on.
  const chunk = `// chunk\nexports.query = function (cs) {\n  return cs();\n};\n\n\n\n\n\n\nexports.send = function (cs) {\n  return cs();\n};\n`;
  const map = {
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: mapOf(user, pathToFileURL(DB_FILE).href) },
      { offset: { line: 10, column: 0 }, map: mapOf(lib, pathToFileURL(PG_FILE).href) },
    ],
  };
  const dir = path.join(TMP, '.next', 'dev', 'server', 'chunks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'c.js'), chunk);
  fs.writeFileSync(path.join(dir, 'c.js.map'), JSON.stringify(map));

  const bundle = createRequire(import.meta.url)(path.join(dir, 'c.js'));
  const site = bundle.query(callerSite);
  assert.equal(site.file, DB_FILE);
  assert.equal(site.line, 3);

  // A frame that maps into node_modules isn't yours: the next one (this test) is.
  const fromLib = bundle.send(callerSite);
  assert.equal(fromLib.file, THIS_FILE);
});

test('webpack eval module: found by its sourceURL (webpack-internal:///…) and its inline map', () => {
  // next dev runs Node with --enable-source-maps, which is what lets Node
  // know the maps of eval'd code; turn the same on here.
  process.setSourceMapsEnabled(true);
  const original = '// db\nexport function query(cs) {\n  return cs();\n}\n';
  // The eval'd module: the same function, reshaped the way a bundler would.
  const s = new MagicString(original);
  s.overwrite(0, original.indexOf('  return'), '(function (cs) {\n\n');
  s.overwrite(original.indexOf('}\n'), original.length, '})');
  const evalMap = s.generateMap({ hires: true, source: pathToFileURL(DB_FILE).href });
  const inline = Buffer.from(JSON.stringify(evalMap)).toString('base64');
  const fn = (0, eval)(`${s.toString()}\n//# sourceURL=webpack-internal:///(rsc)/./lib/db.js\n//# sourceMappingURL=data:application/json;base64,${inline}`);
  const site = fn(callerSite);
  assert.equal(site.file, DB_FILE);
  assert.equal(site.line, 3);
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
