# Feel

**Alt + right-click any element in your React app and see the whole stack behind it** —
down to the line of code, the API route, the backend handler, the SQL and the tables.

[![CI](https://github.com/Nirbhay71/Feel-your-project/actions/workflows/ci.yml/badge.svg)](https://github.com/Nirbhay71/Feel-your-project/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@feel-dev/vite-plugin)](https://www.npmjs.com/package/@feel-dev/vite-plugin)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why

More and more apps are generated or "vibe coded". They work — but nobody quite
knows what happens under the hood. Feel answers "where does *this* come from?"
for any piece of UI, without reading the whole codebase:

```
The "Sales this week" chart (from the demo app)
  component   Dashboard › SalesChart                     SalesChart.jsx:11
  frontend    ⇢ @tanstack/react-query ⇢ fetchSales        api.js:13
  API         GET /api/sales
  backend     inline handler                             server/routes/sales.js:7
  SQL         SELECT … FROM orders …                     sales.js:8 · 10 ms · 7 rows
  tables      orders → users, products · ← notifications · changed 2m ago
```

Every step opens the actual code. Calls a component *could* make but hasn't yet
(buttons nobody clicked) show up too, found from the code alone.

## What you get

- **Component chain** from React's own tree, with the exact JSX line of each usage
- **Data flow** per component, as a list or a graph: frontend functions → API route →
  backend handler → SQL queries → tables → related tables
- **Code viewer** at every step, and "Open in editor"
- **Possible calls**: static analysis of calls not made yet (dashed in the graph)
- **ORMs**: Prisma and Drizzle queries show their SQL, tables and the line in your code
  that asked for them — also for calls not made yet
- **Database view** (Postgres): columns, keys, foreign keys both ways, and — opt-in —
  every change, linked to the request and component that caused it
- **Dev only**: nothing is added to production builds

## Quick start

```bash
npm install -D @feel-dev/vite-plugin     # in your frontend
npm install -D @feel-dev/node            # in your backend
```

```js
// vite.config.js
import feel from '@feel-dev/vite-plugin';
export default defineConfig({
  plugins: [feel({ database: process.env.DATABASE_URL }), react()], // database is optional
});
```

```js
// first line of your server entry
import '@feel-dev/node/register';      // or: require('@feel-dev/node/register')
```

Run your app as usual, then **hold Alt** (outlines) and **Alt + right-click** (panel).
Full setup guide: [packages/vite-plugin/README.md](packages/vite-plugin/README.md).

## Supported

| | |
|---|---|
| Frontend | React 19 (dev mode) on Vite — tested with Vite 7 and 8 |
| Data fetching | `fetch`, axios, `axios.create` instances (incl. interceptors), wrapper functions, custom hooks, API objects (`userApi.getAll()`), React Query, SWR |
| Imports | relative, Vite `resolve.alias`, tsconfig/jsconfig `paths` + `baseUrl`, `package.json` `"imports"` |
| Backend | Express 4 and 5 — ES modules or CommonJS, routers, `app.use` mounts, controllers |
| Database | Postgres: queries per request, tables, structure, change history — through `pg`, **Prisma** (7, or 6 with `@prisma/adapter-pg`) or **Drizzle** (`drizzle-orm/node-postgres`) |
| Other ORMs on `pg` | Knex, Sequelize, TypeORM, …: SQL and tables per request; the line in your code when the ORM keeps it on the stack |
| Layout | frontend and backend in one folder or side by side (`client/` + `server/`) |

## Not yet

- **Prisma's Rust engine** (Prisma 6 and older without a driver adapter) — its queries don't go through `pg`
- **MySQL / SQLite** drivers — the static side understands Drizzle's MySQL and SQLite tables, the runtime side is Postgres only
- **Next.js**, Create React App, Vue, Svelte — Feel needs Vite + React today
- **Supabase** (browser talks to the database directly)
- React 18 and older show a simpler, DOM-based component chain

Want one of these? See [CONTRIBUTING.md](CONTRIBUTING.md) — PRs very welcome.

## How it works

| Package | Runs in | Does |
|---|---|---|
| [`@feel-dev/vite-plugin`](packages/vite-plugin) | Vite | tags every JSX element with its file:line, tags components, injects the client |
| [`@feel-dev/client`](packages/client) | browser | Alt + right-click, React fiber chain, captures fetch/XHR/axios with stack traces, the panel |
| [`@feel-dev/agent`](packages/agent) | Vite dev server | maps stacks through sourcemaps, builds the call graph, static analysis, reads Postgres |
| [`@feel-dev/node`](packages/node) | your backend | reports the Express route, handler and SQL of each request (raw `pg`, Prisma, Drizzle) in a response header |

## Try the demo

```bash
npm install
npm run db      # Postgres in Docker on :5433
npm run demo    # API :3001 + app :5173
```

## Contributing & security

- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, code layout, tests
- [SECURITY.md](SECURITY.md) — what Feel can access, and how to report issues privately

## License

[MIT](LICENSE)
