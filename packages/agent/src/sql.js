// Layer 3 — which tables does a SQL statement touch, and how?
//
//   SELECT … FROM orders JOIN users …          → orders (read), users (read)
//   INSERT INTO notifications … RETURNING id   → notifications (write)
//
// Uses pgsql-ast-parser (a real Postgres SQL parser). If it can't parse a
// query, falls back to a simple regex so we still show something.

import { parse, astVisitor } from 'pgsql-ast-parser';

export function tablesInSql(sql) {
  try {
    return fromAst(sql);
  } catch {
    return fromRegex(sql);
  }
}

function fromAst(sql) {
  const access = new Map(); // table → 'read' | 'write'
  const cteNames = new Set(); // WITH x AS (…) — x is not a real table
  const touch = (name, kind) => {
    if (!name) return;
    if (kind === 'write' || !access.has(name)) access.set(name, kind);
  };

  const visitor = astVisitor((v) => ({
    with: (st) => {
      st.bind.forEach((b) => cteNames.add(b.alias.name));
      v.super().with(st);
    },
    tableRef: (t) => touch(t.name, 'read'),
    insert: (st) => {
      touch(st.into.name, 'write');
      v.super().insert(st);
    },
    update: (st) => {
      touch(st.table.name, 'write');
      v.super().update(st);
    },
    delete: (st) => {
      touch(st.from.name, 'write');
      v.super().delete(st);
    },
  }));

  for (const statement of parse(sql)) visitor.statement(statement);

  return [...access]
    .filter(([name]) => !cteNames.has(name))
    .map(([name, kind]) => ({ name, access: kind }));
}

function fromRegex(sql) {
  const out = new Map();
  for (const [, keyword, name] of sql.matchAll(/\b(from|join|into|update)\s+"?([\w.]+)"?/gi)) {
    const kind = /into|update/i.test(keyword) ? 'write' : 'read';
    const table = name.replace(/^public\./, '');
    if (kind === 'write' || !out.has(table)) out.set(table, kind);
  }
  return [...out].map(([name, access]) => ({ name, access }));
}
