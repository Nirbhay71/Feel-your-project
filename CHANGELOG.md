# Changelog

## 0.2.0 — "Sixth Sense"

Feel now sees through ORMs.

### Added

- **Prisma** (7, or 6 with `@prisma/adapter-pg`): SQL, tables, timing and the
  `prisma.user.findMany()` line in your code for every query a request runs.
- **Drizzle** (`drizzle-orm/node-postgres`): the same, including lazy queries
  (`await db.select().from(users)`), `Promise.all`, transactions and
  `db.query.users.findMany()`. CommonJS and ES modules.
- **Other ORMs on `pg`** (Knex, Sequelize, TypeORM, …): their SQL and tables now
  show up per request instead of being dropped. Queries without a line in your
  code are marked "ORM" and open the route's handler.
- **Possible calls for ORMs**: routes nobody has called yet show their Prisma
  and Drizzle queries and tables, found from code alone — Prisma models mapped
  to tables through `schema.prisma` (incl. `@@map`), Drizzle tables through
  `pgTable('name')` / `mysqlTable` / `sqliteTable`, re-exports and
  `drizzle(…, { schema })`.
- **MySQL / MariaDB** via `mysql2` (callbacks, `mysql2/promise`, pools,
  `getConnection()`, transactions) and `drizzle-orm/mysql2`: SQL, tables,
  timing, rows and the line in your code for every query a request runs.
  Tables are found in MySQL SQL too — backticks, `?` placeholders,
  `INSERT IGNORE`, `REPLACE`, `ON DUPLICATE KEY UPDATE`, `LIMIT 10, 20`.
  Possible calls list `pool.execute('SQL')`. The table view stays
  Postgres-only; prepared statements made with `connection.prepare()` aren't
  recorded yet.

### Changed

- `@feel-dev/node` follows async stack frames to find the line in your code
  that sent a query.

## 0.1.0

First release: component chain, API route, Express handler, SQL and tables per
request, possible calls, Postgres table view and change history.
