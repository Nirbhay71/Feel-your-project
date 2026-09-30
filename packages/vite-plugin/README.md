# @feel-dev/vite-plugin

**Alt + right-click any element in your React app** and see the full stack behind it:

```
component → the JSX line that rendered it → the functions that fetched its data
  → API route → backend handler → SQL queries → tables (+ structure, related tables, recent changes)
```

Every step opens the actual code. Built for understanding apps you didn't write line by line.

Dev only — nothing is added to production builds.

## Install

```bash
npm install -D @feel-dev/vite-plugin @feel-dev/node
```

## Set up

**1. Frontend** — `vite.config.js`:

```js
import feel from '@feel-dev/vite-plugin';

export default defineConfig({
  plugins: [
    feel({ database: process.env.DATABASE_URL }), // before react()
    react(),
  ],
});
```

`database` is optional. With it, the panel can show table structure, relations and recent changes (Postgres).

**2. Backend** — first line of your server entry file (Express + `pg`, Prisma or Drizzle):

```js
import '@feel-dev/node/register';        // ES modules
// or
require('@feel-dev/node/register');      // CommonJS
```

It must come before anything that loads your routes or database code.

**3. Proxy your API through Vite** (or allow the `X-Feel-Route` response header cross-origin — `@feel-dev/node` already exposes it):

```js
server: { proxy: { '/api': 'http://localhost:3001' } }
```

## Use

- **Hold Alt** and move the mouse — elements outline with their component name.
- **Alt + right-click** — opens the panel: component chain, the code, and the data flow.
- **List / Graph** toggle — the same flow as a list or a left-to-right graph.
- Calls the component *could* make but hasn't yet (found in the code) show as **possible calls**, dashed in the graph.
- **Esc** closes it.

## What it understands

| | |
|---|---|
| Data fetching | `fetch`, axios (+ `axios.create` instances), custom hooks, wrapper functions, React Query, SWR |
| Imports | relative, Vite `resolve.alias`, tsconfig/jsconfig `paths` + `baseUrl`, `package.json` `"imports"` |
| Backend | Express 4/5 (`app.get`, `router.get`, `app.route()`, `app.use('/prefix', router)`) |
| Database access | `pg`, Prisma (7, or 6 with `@prisma/adapter-pg`), Drizzle (`node-postgres`); SQL from other ORMs on `pg` |
| Possible queries | `pool.query('SQL')`, `prisma.<model>.<op>()` (tables from `schema.prisma`, incl. `@@map`), Drizzle `select().from()` / joins / `insert` / `update` / `delete` / `db.query.<table>` (tables from `pgTable('name')`, `mysqlTable`, `sqliteTable`) |
| Database | Postgres: tables per query (read/write), columns, keys, foreign keys both ways, change history (opt-in triggers) |

## Requirements

- React 19 in development mode (for exact component usage lines; falls back to a DOM-based chain otherwise)
- Vite 5+
- Node 20.19+

## Good to know

- **Change tracking** is off until you click "Turn on change tracking" in the panel. It adds a `feel_audit` table and a trigger per table to the database you point it at — use it on a dev database.
- The agent only reads source files inside your project — plus your Prisma schema, for model → table names — and never `.env` or other non-code files.
