// Layer 3 — reading the database itself: table structure, relations, changes.
//
// Structure comes from Postgres' own catalog (information_schema, pg_constraint).
// Changes come from an optional audit log: a `feel_audit` table filled by
// triggers. Those triggers are only installed when the user clicks
// "Turn on change tracking" in the panel, because they modify the database.

import pg from 'pg';

const SCHEMA = 'public';
const RECENT = 15;

export function createDb(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 2 });

  async function tableExists(name) {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2',
      [SCHEMA, name],
    );
    return rowCount > 0;
  }

  async function auditEnabled() {
    const { rows } = await pool.query(`SELECT to_regclass('${SCHEMA}.feel_audit') IS NOT NULL AS on`);
    return rows[0].on;
  }

  async function getTable(name) {
    if (!(await tableExists(name))) return null;

    const [columns, primaryKey, foreignKeys, count] = await Promise.all([
      pool.query(
        `SELECT column_name AS name, data_type AS type, is_nullable = 'YES' AS nullable, column_default AS default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [SCHEMA, name],
      ),
      pool.query(
        `SELECT a.attname AS name
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
         WHERE i.indrelid = $1::regclass AND i.indisprimary`,
        [`${SCHEMA}.${name}`],
      ),
      // Foreign keys in both directions: this table → others, others → this table.
      pool.query(
        `SELECT c.conrelid::regclass::text  AS from_table, a.attname  AS from_column,
                c.confrelid::regclass::text AS to_table,   af.attname AS to_column
         FROM pg_constraint c
         CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(col, refcol)
         JOIN pg_attribute a  ON a.attrelid  = c.conrelid  AND a.attnum  = k.col
         JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = k.refcol
         WHERE c.contype = 'f' AND (c.conrelid = $1::regclass OR c.confrelid = $1::regclass)`,
        [`${SCHEMA}.${name}`],
      ),
      pool.query(`SELECT count(*)::int AS n FROM ${quoteIdent(SCHEMA)}.${quoteIdent(name)}`),
    ]);

    const references = foreignKeys.rows.filter((f) => f.from_table === name);
    const referencedBy = foreignKeys.rows.filter((f) => f.to_table === name && f.from_table !== name);
    const related = [...new Set([...references.map((f) => f.to_table), ...referencedBy.map((f) => f.from_table)])];

    const audit = await auditEnabled();
    let changes = [];
    let relatedChanges = [];
    if (audit) {
      [changes, relatedChanges] = await Promise.all([
        recentChanges([name]),
        related.length ? recentChanges(related) : [],
      ]);
    }

    return {
      name,
      rowCount: count.rows[0].n,
      columns: columns.rows,
      primaryKey: primaryKey.rows.map((r) => r.name),
      references, // [{ from_column, to_table, to_column }]
      referencedBy, // [{ from_table, from_column, to_column }]
      audit,
      changes,
      relatedChanges,
    };
  }

  async function recentChanges(tables) {
    const { rows } = await pool.query(
      `SELECT id, table_name, op, row_data, old_data, changed_at
       FROM feel_audit WHERE table_name = ANY ($1)
       ORDER BY id DESC LIMIT ${RECENT}`,
      [tables],
    );
    return rows;
  }

  // Install the audit table + one trigger per table in the schema.
  async function enableAudit() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS feel_audit (
        id         bigserial PRIMARY KEY,
        table_name text        NOT NULL,
        op         text        NOT NULL,          -- INSERT | UPDATE | DELETE
        row_data   jsonb,                         -- the row after the change
        old_data   jsonb,                         -- the row before the change
        changed_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE OR REPLACE FUNCTION feel_audit_fn() RETURNS trigger AS $$
      BEGIN
        INSERT INTO feel_audit (table_name, op, row_data, old_data)
        VALUES (TG_TABLE_NAME, TG_OP,
                CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
                CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END);
        RETURN NULL;
      END $$ LANGUAGE plpgsql;
    `);

    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE' AND table_name <> 'feel_audit'`,
      [SCHEMA],
    );
    for (const { table_name } of rows) {
      const t = `${quoteIdent(SCHEMA)}.${quoteIdent(table_name)}`;
      await pool.query(`DROP TRIGGER IF EXISTS feel_audit ON ${t}`);
      await pool.query(
        `CREATE TRIGGER feel_audit AFTER INSERT OR UPDATE OR DELETE ON ${t}
         FOR EACH ROW EXECUTE FUNCTION feel_audit_fn()`,
      );
    }
    return { tables: rows.map((r) => r.table_name) };
  }

  return { getTable, enableAudit };
}

// "order" → "\"order\"" — safe to put in SQL as an identifier.
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}
