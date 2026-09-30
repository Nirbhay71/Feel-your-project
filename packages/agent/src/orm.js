// Static ORM queries: which tables does an ORM call touch — from code alone.
// The ORM counterpart of pool.query('SQL') in static.js.
//
//   prisma.orderItem.findMany(…)     → order_items   (schema.prisma: model OrderItem @@map("order_items"))
//   db.select().from(users)          → users         (schema.js: export const users = pgTable('users', …))
//   db.insert(orders).values(…)      → orders ✎
//   db.query.users.findMany(…)       → users         (drizzle(pool, { schema }) → schema.js)
//
// Each match is { sql, tables } — `sql` is the call as written (shortened),
// shown where raw SQL would be.

import fs from 'node:fs';
import path from 'node:path';
import { traverse } from './ast.js';
import { loadFile, importTarget, refTarget, resolveImport } from './files.js';

const PRISMA_READ = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy']);
const PRISMA_WRITE = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany']);
const DRIZZLE_READ = new Set(['from', 'leftJoin', 'rightJoin', 'innerJoin', 'fullJoin', 'crossJoin']);
const DRIZZLE_WRITE = new Set(['insert', 'update', 'delete']);
const DRIZZLE_RELATIONAL = new Set(['findMany', 'findFirst']);
const TABLE_FACTORY = /^(pg|mysql|sqlite|singlestore)Table$/;
const MAX_LABEL = 80;

// p: a CallExpression path in `file` (whose source is `code`). null if it
// isn't a Prisma or Drizzle call we can place. rootDir bounds the search for
// schema.prisma.
export async function ormQuery(p, file, code, rootDir) {
  const callee = p.node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return null;
  const op = callee.property.name;

  // prisma.<model>.<op>(…)  /  db.query.<table>.findMany(…)
  if ((PRISMA_READ.has(op) || PRISMA_WRITE.has(op)) && callee.object.type === 'MemberExpression' && !callee.object.computed) {
    const accessor = callee.object.property.name;
    const owner = callee.object.object;
    if (DRIZZLE_RELATIONAL.has(op) && owner.type === 'MemberExpression' && !owner.computed && owner.property.name === 'query') {
      const table = await relationalTable(p.get('callee.object.object.object'), accessor, file);
      if (table) return { sql: label(code, p.node), tables: [{ name: table, access: 'read' }] };
    }
    const model = (await prismaModels(file, rootDir))?.get(accessor);
    if (model) {
      const access = PRISMA_READ.has(op) ? 'read' : 'write';
      return { sql: `${label(code, callee)}(…)`, tables: [{ name: model, access }] };
    }
  }

  // db.select().from(users), .leftJoin(orders, …), db.insert(orders), …
  if (DRIZZLE_READ.has(op) || DRIZZLE_WRITE.has(op)) {
    const arg = p.get('arguments')[0];
    const table = arg && (await drizzleTable(arg, file));
    if (table) return { sql: label(code, p.node), tables: [{ name: table, access: DRIZZLE_WRITE.has(op) ? 'write' : 'read' }] };
  }
  return null;
}

// The call as written, on one line and cut short:  db.select().from(users)
function label(code, node) {
  const text = code.slice(node.start, node.end).replace(/\s+/g, ' ').trim();
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
}

// --- Prisma ---------------------------------------------------------------------

// Cached briefly, like the route scan — edits to the schema show up on the next click.
const schemaByDir = new Map(); // dir → { at, promise: Promise<Map accessor → table | null> }

// The nearest Prisma schema between `file` and the project root, as client
// accessor → table name:
//   model OrderItem { … @@map("order_items") }   →   orderItem → order_items
// Only model names and @@map are used; nothing else in the schema is kept.
async function prismaModels(file, rootDir) {
  const dir = path.dirname(file);
  const hit = schemaByDir.get(dir);
  if (hit && Date.now() - hit.at < 3000) return hit.promise;
  const entry = { at: Date.now(), promise: findSchema(dir, rootDir) };
  schemaByDir.set(dir, entry);
  return entry.promise;
}

async function findSchema(dir, rootDir) {
  const root = path.resolve(rootDir ?? dir);
  for (let d = dir; ; d = path.dirname(d)) {
    if (d !== root && !d.startsWith(root + path.sep)) return null; // never outside the project
    for (const candidate of [path.join(d, 'prisma', 'schema.prisma'), path.join(d, 'schema.prisma'), path.join(d, 'prisma', 'schema')]) {
      const files = schemaFiles(candidate);
      if (files.length) return parseSchema(files.map((f) => fs.readFileSync(f, 'utf8')).join('\n'));
    }
    if (d === root) return null;
  }
}

// A schema file, or a folder of them (prismaSchemaFolder).
function schemaFiles(target) {
  try {
    const stat = fs.statSync(target);
    if (stat.isFile()) return [target];
    return fs
      .readdirSync(target)
      .filter((f) => f.endsWith('.prisma'))
      .map((f) => path.join(target, f));
  } catch {
    return [];
  }
}

export function parseSchema(text) {
  const models = new Map();
  for (const [, name, body] of text.matchAll(/^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm)) {
    const table = body.match(/@@map\(\s*(?:name\s*:\s*)?"([^"]+)"/)?.[1] ?? name;
    models.set(name[0].toLowerCase() + name.slice(1), table);
  }
  return models;
}

// --- Drizzle --------------------------------------------------------------------

// A reference to a Drizzle table (`users`, `schema.users`) → its SQL name.
async function drizzleTable(p, file) {
  const target = refTarget(p, file);
  return target && tableExport(target.file, target.name, 0);
}

// export const users = pgTable('users', …) — also re-exported from an index
// file, or on a pgSchema: export const users = auth.table('users', …).
async function tableExport(file, name, depth) {
  if (depth > 3 || name.includes('.')) return null;
  const ast = (await loadFile(file).catch(() => null))?.ast;
  if (!ast) return null;

  for (const stmt of ast.program.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
    if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id.type === 'Identifier' && d.id.name === name) return tableName(d.init);
      }
    }
    // export { users } from './users.js'  /  export * from './users.js'
    if (!stmt.source || !stmt.type.startsWith('Export')) continue;
    const spec = stmt.specifiers?.find((s) => s.local && (s.exported.name ?? s.exported.value) === name);
    if (stmt.type === 'ExportAllDeclaration' || spec) {
      const from = resolveImport(file, stmt.source.value);
      const found = from && (await tableExport(from, spec ? (spec.local.name ?? spec.local.value) : name, depth + 1));
      if (found) return found;
    }
  }
  return null;
}

function tableName(init) {
  if (init?.type !== 'CallExpression' || init.arguments[0]?.type !== 'StringLiteral') return null;
  const c = init.callee;
  const isFactory =
    (c.type === 'Identifier' && TABLE_FACTORY.test(c.name)) ||
    (c.type === 'MemberExpression' && !c.computed && c.property.name === 'table'); // pgSchema('auth').table(…)
  return isFactory ? init.arguments[0].value : null;
}

// db.query.<name> — find db's drizzle(…, { schema }) call, then <name> in
// that schema module.
async function relationalTable(dbPath, name, file) {
  if (!dbPath.isIdentifier()) return null;
  const binding = dbPath.scope.getBinding(dbPath.node.name);
  if (!binding) return null;

  let dbFile = file;
  let init = binding.path.isVariableDeclarator() ? binding.path.get('init') : null;
  const imported = importTarget(binding, file);
  if (imported) {
    dbFile = imported.file;
    init = await exportedInit(imported.file, imported.name);
  }
  const schemaRef = init && schemaOption(init);
  if (!schemaRef) return null;
  // import * as schema from './schema.js' → the table is an export of that module
  const target = refTarget(schemaRef, dbFile);
  return target && (target.name === '*' || target.name === 'default') ? tableExport(target.file, name, 0) : null;
}

// The initializer of `export const <name> = …` (or `export default …`) as a path.
async function exportedInit(file, name) {
  const loaded = await loadFile(file).catch(() => null);
  if (!loaded?.ast) return null;
  let found = null;
  traverse(loaded.ast, {
    VariableDeclarator(p) {
      if (p.node.id.type === 'Identifier' && p.node.id.name === name && p.scope.path.isProgram()) {
        found = p.get('init');
        p.stop();
      }
    },
    ExportDefaultDeclaration(p) {
      if (name === 'default') {
        found = p.get('declaration');
        p.stop();
      }
    },
  });
  return found;
}

// drizzle(pool, { schema })  /  drizzle({ client, schema: schema })
function schemaOption(init) {
  if (!init.isCallExpression()) return null;
  for (const arg of init.get('arguments')) {
    if (!arg.isObjectExpression()) continue;
    const prop = arg.get('properties').find((pr) => pr.isObjectProperty() && (pr.node.key.name ?? pr.node.key.value) === 'schema');
    if (prop) return prop.get('value');
  }
  return null;
}
