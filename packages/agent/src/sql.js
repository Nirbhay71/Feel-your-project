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

// SQL can come from anywhere (static analysis of your code, POST /sql), and
// some of the fallback regexes slow down on huge runs of whitespace — so
// look at the first 10,000 characters only, and give the regexes the SQL
// with whitespace runs collapsed (which doesn't change which tables match).
const MAX_SQL = 10000;

export function tablesInSql(sql) {
  sql = String(sql).slice(0, MAX_SQL);
  const mysql = looksLikeMysql(sql);
  let tables;
  try {
    tables = fromAst(sql);
  } catch {
    tables = mysql ? fromMysql(sql) : fromRegex(collapse(sql));
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

const collapse = (sql) => sql.replace(/\s+/g, ' ');

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
const MYSQL_ONLY = new RegExp(
  [
    /`|\?/,
    /(?<!:):[A-Za-z_]/, // :name placeholders (not a ::cast)
    /^ ?REPLACE\b/,
    /\bON DUPLICATE KEY\b/,
    /\b(INSERT|UPDATE|DELETE) (LOW_PRIORITY|DELAYED|HIGH_PRIORITY|QUICK|IGNORE)\b/,
    /\bLIMIT [^ ,]+ ?,/, // LIMIT 10, 20
    /\bFROM DUAL\b/,
    /\bSTRAIGHT_JOIN\b/,
    /^ ?DELETE \w+( ?, ?\w+)* FROM\b/, // DELETE o FROM orders o JOIN users u …
    /^ ?(UPDATE|DELETE)\b[^;]*\bLIMIT \d/, // UPDATE … LIMIT 1
    /^ ?UPDATE [^ ,;]+( (AS )?\w+)? ?,/, // UPDATE users, orders SET …
  ]
    .map((re) => re.source)
    .join('|'),
  'i',
);

// Tested on the SQL with whitespace collapsed (hence the single spaces above).
function looksLikeMysql(sql) {
  return MYSQL_ONLY.test(collapse(sql.replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"/g, "''")));
}

const isDual = (name) => /^dual$/i.test(name);

function fromMysql(sql) {
  const statements = scanMysql(sql).split(';');
  const normal = statements.map(rewriteStatement).join(';');
  let tables;
  try {
    tables = fromAst(normal);
  } catch {
    tables = fromMysqlRegex(normal);
  }
  tables = withReads(tables, statements.flatMap(onDuplicateKeyReads));
  // `SELECT * FROM ?` / `??` — a placeholder, not a table name.
  tables = tables.filter((t) => !t.name.startsWith('$') && !t.name.startsWith('?'));
  // Postgres SQL can still get here (the jsonb `?` operator looks like a
  // placeholder). If the rewrite found nothing, keep the old answer.
  if (!tables.some((t) => !isDual(t.name))) {
    const old = fromRegex(collapse(sql));
    if (old.length) return old;
  }
  return tables;
}

// Tables that aren't in the list yet, added as read.
function withReads(tables, names) {
  const seen = new Set(tables.map((t) => t.name));
  const reads = [...new Set(names)].filter((name) => !seen.has(name)).map((name) => ({ name, access: 'read' }));
  return [...tables, ...reads];
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
//   … ON DUPLICATE KEY UPDATE …  → dropped (tables read in it are kept, see onDuplicateKeyReads)
//   UPDATE / DELETE … ORDER BY … LIMIT n → dropped
//   LIMIT 10, 20                 → LIMIT 20 OFFSET 10
//   STRAIGHT_JOIN                → JOIN
// Whitespace runs become one space once comments are gone, which keeps the
// regexes below fast on any input.
function scanMysql(sql) {
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
  return collapse(out);
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

const ON_DUPLICATE_KEY = /\s+ON\s+DUPLICATE\s+KEY\s+UPDATE\b[\s\S]*$/i;

// INSERT … ON DUPLICATE KEY UPDATE total = (SELECT sum(x) FROM items) — the
// clause is dropped for the parser, but the tables it reads still count.
// (`a = VALUES(a)` names no table: only FROM / JOIN are looked at.)
function onDuplicateKeyReads(st) {
  const clause = st.match(ON_DUPLICATE_KEY)?.[0] ?? '';
  return [...clause.matchAll(TABLE_REF)].filter(([, keyword]) => /from|join/i.test(keyword)).map(([, , ref]) => lastPart(ref));
}

function rewriteStatement(st) {
  st = st
    .replace(/^(\s*)REPLACE\b/i, '$1INSERT')
    .replace(/\b(INSERT|UPDATE|DELETE)(?:\s+(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|QUICK|IGNORE)\b)+/gi, '$1')
    .replace(/\bSELECT\s+STRAIGHT_JOIN\b/gi, 'SELECT')
    .replace(/\bSTRAIGHT_JOIN\b/gi, 'JOIN')
    .replace(ON_DUPLICATE_KEY, '');
  if (/^\s*(UPDATE|DELETE)\b/i.test(st)) st = st.replace(/\s+(?:ORDER\s+BY\b[\s\S]*?\s+)?LIMIT\b[\s\S]*$/i, '');
  return st.replace(/\bLIMIT\s+(\S+?)\s*,\s*(\S+)/gi, 'LIMIT $2 OFFSET $1');
}

// For what's left after the rewrite that the parser still can't read —
// multi-table UPDATE / DELETE, INSERT … SET. Knows "quoted" and db.table
// names (keeps the table, like the parser). Approximations:
//   DELETE o FROM orders o JOIN users u …   → orders (write), users (read)
//   UPDATE users u JOIN orders o … SET …    → users (write), orders (read)
//   UPDATE users, orders SET …              → users (write), orders (write)
// (MySQL may change rows in any table listed before SET, so all of them
// count as written; joined tables only as read.)
const NAME = /(?:"(?:[^"]|"")+"|[\w$]+)(?: ?\. ?(?:"(?:[^"]|"")+"|[\w$]+))*/;
const TABLE_REF = new RegExp(`\\b(from|join|into|update) (${NAME.source})`, 'gi');
const LAST_PART = /(?:"(?:[^"]|"")+"|[\w$]+)$/;
const JOIN_WORD = /\b(?:(?:inner|cross|left|right|natural|straight)(?: outer)? )?join\b/i;

function fromMysqlRegex(sql) {
  const out = new Map();
  const touch = (table, kind) => {
    if (kind === 'write' || !out.has(table)) out.set(table, kind);
  };
  for (const statement of sql.split(';')) {
    let deleteTarget = /^ ?delete\b/i.test(statement);
    for (const match of statement.matchAll(TABLE_REF)) {
      const [, keyword, ref] = match;
      // SELECT … FOR UPDATE — a lock, not a table
      if (/update/i.test(keyword) && /\bfor $/i.test(statement.slice(Math.max(0, match.index - 5), match.index))) continue;
      let kind = /into|update/i.test(keyword) ? 'write' : 'read';
      if (deleteTarget && /from/i.test(keyword)) {
        kind = 'write'; // the first FROM of a DELETE is what it deletes from
        deleteTarget = false;
      }
      touch(lastPart(ref), kind);
    }
    for (const table of updateTargets(statement)) touch(table, 'write');
  }
  return [...out].map(([name, access]) => ({ name, access }));
}

// UPDATE users u, orders o SET … → users, orders. Only for a comma list:
// with one table, what comes before SET is that table and its joins.
function updateTargets(statement) {
  const head = statement.match(/^ ?update (.*?) set\b/i)?.[1].split(JOIN_WORD)[0].split(',') ?? [];
  if (head.length < 2) return [];
  return head.map((item) => item.trim().match(NAME)?.[0]).filter(Boolean).map(lastPart);
}

const lastPart = (ref) => unquote(ref.match(LAST_PART)[0]); // feel.users → users
const unquote = (name) => (name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name);
