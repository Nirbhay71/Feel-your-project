# Contributing to Feel

Thanks for helping! The most valuable contributions right now are **support
for more stacks** (Next.js, Supabase, tRPC, MySQL, …) and **bug reports from
real apps** — Feel gets better every time it meets code it didn't expect.

## Set up

Needs Node 20.19+ and Docker (for the demo's Postgres).

```bash
git clone https://github.com/Nirbhay71/Feel-your-project.git
cd Feel-your-project
npm install
npm test            # ~1 second, no database needed
npm run db          # demo Postgres on :5433
npm run demo        # demo API on :3001 + Vite on :5173
```

Open http://localhost:5173 and **Alt + right-click** anything.

## How the code is organised

```
packages/
  vite-plugin/  Vite plugin: tags JSX with data-src, tags components, injects the client, mounts the agent
  client/       Browser: Alt + right-click, React fiber chain, fetch/XHR/axios capture, the panel (list + graph)
  agent/        Node, inside Vite dev: source lookup, stack → original lines, call graph,
                static "possible calls", import resolution, SQL parsing, Postgres inspection
  node/         Backend: Express, pg and Drizzle instrumentation (X-Feel-Route header, per-request context)
demo/           React + Express + Postgres app that exercises every supported pattern
tests/          node:test suites; tests/fixtures/ holds small apps to analyse
```

Each file starts with a comment explaining its job — start there.

## Making a change

1. **Write a test first** in `tests/`. If Feel needs code to analyse, add a
   small fixture app under `tests/fixtures/` (see `cjs-app/`).
2. Make it pass. Keep the style of the surrounding code: small functions,
   comments that explain *why*.
3. If it's user-visible, try it in the demo (or add the pattern to the demo).
4. `npm test` must pass — CI runs it on Linux and Windows, Node 20 and 22.

## Adding support for a new library

Most support lives in the agent:

- **A new way of calling APIs** (like SWR or an axios instance) →
  `packages/agent/src/static.js` (`frontendCalls`) for the static side. The
  runtime side usually works already via fetch/XHR capture.
- **A new backend framework** → route scanning in `static.js` (`scanRoutes`)
  and handler lookup in `handler.js`, plus runtime instrumentation in
  `packages/node/`.
- **A new database layer** → `packages/node/` to record queries per request
  (an ORM on `pg` usually works already — see `drizzle.js` for one that needs
  help finding your line), `packages/agent/src/sql.js` to find their tables,
  and `packages/agent/src/orm.js` for its calls in "possible calls".

## Reporting bugs

Use the bug report template — your stack details (Vite, data fetching,
backend, database, aliases) matter more than anything else.
