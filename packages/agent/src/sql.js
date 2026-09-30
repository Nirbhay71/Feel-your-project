// Layer 3 — which tables does a SQL statement touch, and how?
//
//   SELECT … FROM orders JOIN users …          → orders (read), users (read)
//   INSERT INTO notifications … RETURNING id   → notifications (write)
//
// Uses pgsql-ast-parser (a real Postgres SQL parser). If it can't parse a
// query, falls back to a simple regex so we still show something.
//
// MySQL / MariaDB SQL (mysql2) trips the Postgres parser — `backticks`, ?
// placeholders, INSERT IGNORE, ON DUPLICATE KEY UPDATE, LIMIT 10, 20 … — so
// SQL that looks like MySQL is first rewritten into the Postgres shape the
// parser knows (only to find tables — the result is never run), with a
// MySQL-aware regex behind it.

import { parse, astVisitor } from 'pgsql-ast-parser';

export function tablesInSql(sql) {
  const mysql = looksLikeMysql(sql);
  let tables;
  try {
    tables = fromAst(sql);
  } catch {
    tables = mysql ? fromMysql(sql) : fromRegex(sql);
  }
  // SELECT 1 FROM DUAL — MySQL's dummy table, not a real one.
  return mysql ? tables.filter((t) => !isDual(t.name)) : tables;
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

// --- MySQL ------------------------------------------------------------------

// Only SQL with a MySQL-only feature takes the MySQL path, so Postgres
// results stay exactly as they were: `#`, `#>` and `?|` are Postgres
// operators too, and the MySQL rewrite would read them as comments or
// placeholders. Checked with string literals blanked, so '?' in a value
// doesn't count.
const MYSQL_ONLY =
  /`|\?|(?<!:):[A-Za-z_]|^\s*REPLACE\b|\bON\s+DUPLICATE\s+KEY\b|\b(INSERT|UPDATE|DELETE)\s+(LOW_PRIORITY|DELAYED|HIGH_PRIORITY|QUICK|IGNORE)\b|\bLIMIT\s+\S+\s*,|\bFROM\s+DUAL\b/i;

function looksLikeMysql(sql) {
  return MYSQL_ONLY.test(sql.replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"/g, "''"));
}

const isDual = (name) => /^dual$/i.test(name);

function fromMysql(sql) {
  const normal = normaliseMysql(sql);
  let tables;
  try {
    tables = fromAst(normal);
  } catch {
    tables = fromMysqlRegex(normal);
  }
  // `SELECT * FROM ?` / `??` — a placeholder, not a table name.
  tables = tables.filter((t) => !t.name.startsWith('$') && !t.name.startsWith('?'));
  // Postgres SQL can still get here (the jsonb `?` operator looks like a
  // placeholder). If the rewrite found nothing, keep the old answer.
  if (!tables.some((t) => !isDual(t.name))) {
    const old = fromRegex(sql);
    if (old.length) return old;
  }
  return tables;
}

// MySQL → the Postgres shape pgsql-ast-parser understands. One pass over the
// characters so quotes and comments are honoured, then a few per-statement
// rewrites:
//   `users`                      → "users"
//   'it''s ? `x`'                → ''            (literals never matter here)
//   ? / :name                    → $1, $2, …     (?? — an identifier placeholder — is kept)
//   -- …, # …, /* … */           → dropped
//   REPLACE INTO                 → INSERT INTO
//   INSERT IGNORE / UPDATE LOW_PRIORITY / DELETE QUICK … → INSERT / UPDATE / DELETE
//   … ON DUPLICATE KEY UPDATE …  → dropped
//   UPDATE / DELETE … ORDER BY … LIMIT n → dropped
//   LIMIT 10, 20                 → LIMIT 20 OFFSET 10
function normaliseMysql(sql) {
  let out = '';
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'") {
      i = skipQuoted(sql, i, "'");
      out += "''";
    } else if (c === '"') {
      const end = skipQuoted(sql, i, '"');
      out += `"${sql.slice(i + 1, end).replace(/\\"/g, '""')}"`;
      i = end;
    } else if (c === '`') {
      let name = '';
      for (i++; i < sql.length; i++) {
        if (sql[i] === '`' && sql[i + 1] === '`') name += sql[i++];
        else if (sql[i] === '`') break;
        else name += sql[i];
      }
      out += `"${name.replace(/"/g, '""')}"`;
    } else if (c === '?' && next === '?') {
      out += '??';
      i++;
    } else if (c === '?') {
      out += `$${++n}`;
    } else if (c === ':' && sql[i - 1] !== ':' && /[A-Za-z_]/.test(next ?? '')) {
      while (/\w/.test(sql[i + 1] ?? '')) i++;
      out += `$${++n}`;
    } else if ((c === '-' && next === '-' && /\s|^$/.test(sql[i + 2] ?? '')) || c === '#') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 1;
      out += ' ';
    } else {
      out += c;
    }
  }
  return out.split(';').map(rewriteStatement).join(';');
}

// Index of the quote that closes the one at `start` ('' / "" and \' / \"
// escapes skipped), or the end of the string.
function skipQuoted(sql, start, quote) {
  for (let i = start + 1; i < sql.length; i++) {
    if (sql[i] === '\\') i++;
    else if (sql[i] === quote && sql[i + 1] === quote) i++;
    else if (sql[i] === quote) return i;
  }
  return sql.length;
}

function rewriteStatement(st) {
  st = st
    .replace(/^(\s*)REPLACE\b/i, '$1INSERT')
    .replace(/\b(INSERT|UPDATE|DELETE)(?:\s+(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|QUICK|IGNORE)\b)+/gi, '$1')
    .replace(/\s+ON\s+DUPLICATE\s+KEY\s+UPDATE\b[\s\S]*$/i, '');
  if (/^\s*(UPDATE|DELETE)\b/i.test(st)) st = st.replace(/\s+(?:ORDER\s+BY\b[\s\S]*?\s+)?LIMIT\b[\s\S]*$/i, '');
  return st.replace(/\bLIMIT\s+(\S+?)\s*,\s*(\S+)/gi, 'LIMIT $2 OFFSET $1');
}

// For what's left after the rewrite that the parser still can't read —
// multi-table UPDATE / DELETE, INSERT … SET. Knows "quoted" and db.table
// names (keeps the table, like the parser). Approximations:
//   DELETE o FROM orders o JOIN users u …   → orders (write), users (read)
//   UPDATE users u JOIN orders o … SET …    → users (write), orders (read)
const TABLE_REF = /(?<!\bfor\s+)\b(from|join|into|update)\s+((?:"(?:[^"]|"")+"|[\w$]+)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[\w$]+))*)/gi;

const LAST_PART = /(?:"(?:[^"]|"")+"|[\w$]+)$/;

function fromMysqlRegex(sql) {
  const out = new Map();
  for (const statement of sql.split(';')) {
    let deleteTarget = /^\s*delete\b/i.test(statement);
    for (const [, keyword, ref] of statement.matchAll(TABLE_REF)) {
      const table = unquote(ref.match(LAST_PART)[0]); // feel.users → users
      let kind = /into|update/i.test(keyword) ? 'write' : 'read';
      if (deleteTarget && /from/i.test(keyword)) {
        kind = 'write'; // the first FROM of a DELETE is what it deletes from
        deleteTarget = false;
      }
      if (kind === 'write' || !out.has(table)) out.set(table, kind);
    }
  }
  return [...out].map(([name, access]) => ({ name, access }));
}

const unquote = (name) => (name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name);
