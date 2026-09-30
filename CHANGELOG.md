# Changelog

## 0.2.0 — "Sixth Sense"

Feel now sees through ORMs, and works in Next.js.

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
  `INSERT IGNORE`, `REPLACE`, `ON DUPLICATE KEY UPDATE`, `LIMIT 10, 20`,
  `STRAIGHT_JOIN`, multi-table `UPDATE` / `DELETE`.
  Possible calls list `pool.execute('SQL')` and `CALL …`. The table view
  stays Postgres-only; prepared statements made with `connection.prepare()`
  aren't recorded yet; `PoolCluster` is best effort (the line may be missing).

- **Next.js** (App Router, 16+; Turbopack and `next dev --webpack`) through the
  new `@feel-dev/next`: `withFeel(nextConfig)` plus `instrumentation.js`,
  `instrumentation-client.js` and a one-line agent route. DOM tags and the
  component chain for client and Server Components, browser requests mapped
  through Next's sourcemaps, Route Handlers (`app/**/route.ts`) and Pages
  Router API routes with their SQL and the line that sent it, and possible
  calls to route files (`[id]` → `:id`, `[...slug]` → `*`, `(group)` folders
  left out). Works with a `basePath` and with strict TypeScript (types
  included), and keeps its lines through hot reloads. The agent route
  answers only under `next dev`, only to connections from this machine
  (`next dev` listens on the whole network: another machine gets 403 whatever
  `Host` it sends, unless listed in `allowedAddresses`), only for this
  machine's host names (DNS rebinding) and only to the app's own page.
  With an older Next, `withFeel` warns and leaves the config alone.

### Changed

- The JSX tagging moved from the Vite plugin into `@feel-dev/agent`
  (`tagJsx`), shared with `@feel-dev/next`. Output for Vite is unchanged.
- Possible calls: a catch-all route (`app.get('*')`, the usual SPA
  fallback) no longer wins over a specific one, and a URL built on a base
  that may be empty (`${BASE}/api/x`) still finds its route.
- The agent never reads build output (`.next`, `dist`, `build`, `.vite`,
  `coverage`, `.svelte-kit`, `.turbo`) and refuses requests a browser marks
  `Sec-Fetch-Site: cross-site`.
- `.ts` files are parsed without JSX, so old-style casts (`<User>data`) work.

- `@feel-dev/node` follows async stack frames to find the line in your code
  that sent a query.
- The `X-Feel-Route` header stays under 12 KB: with many long queries, each
  query's SQL is shortened, then the last queries are left out ("N more
  queries not shown" in the panel). Before, a big header could exceed Node's
  16 KB limit and break the request behind Vite's proxy.
- Table detection only reads the first 10,000 characters of a statement and
  stays fast on huge or unusual SQL.

### Fixed

- Callback-style `pg` queries (`pool.query(sql, cb)`, `pool.connect(cb)`):
  queries sent from inside a callback were missing, or landed in another
  request, because `pg` runs callbacks in the context of whoever opened the
  connection. Callbacks now run in their own request.

## 0.1.0

First release: component chain, API route, Express handler, SQL and tables per
request, possible calls, Postgres table view and change history.
