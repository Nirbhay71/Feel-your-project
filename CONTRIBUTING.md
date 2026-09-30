# Contributing to Feel

Thanks for helping! The most valuable contributions right now are **support
for more stacks** (Supabase, tRPC, SQLite, Server Actions, …) and **bug reports from
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
  next/         Next.js: withFeel (loader for Turbopack + webpack: JSX tags, route handler wrapping),
                the agent as a route handler, stack mapping through Next's sourcemaps
  client/       Browser: Alt + right-click, React fiber chain, fetch/XHR/axios capture, the panel (list + graph)
  agent/        Node, inside Vite or Next dev: source lookup, stack → original lines, call graph,
                static "possible calls", import resolution, SQL parsing, Postgres inspection
  node/         Backend: Express, Next route handler, pg, mysql2 and Drizzle instrumentation
                (X-Feel-Route header, per-request context)
demo/           React + Express + Postgres app that exercises every supported pattern
tests/          node:test suites; tests/fixtures/ holds small apps to analyse
  e2e/          opt-in end-to-end tests (real next dev + browser), skipped by npm test
```

Each file starts with a comment explaining its job — start there.

## Making a change

1. **Write a test first** in `tests/`. If Feel needs code to analyse, add a
   small fixture app under `tests/fixtures/` (see `cjs-app/`).
2. Make it pass. Keep the style of the surrounding code: small functions,
   comments that explain *why*.
3. If it's user-visible, try it in the demo (or add the pattern to the demo).
4. `npm test` must pass — CI runs it on Linux and Windows, Node 20 and 22.

### The Next.js end-to-end test

`tests/e2e/next.e2e.test.js` runs a real `next dev` on a copy of
`tests/fixtures/next-app` (Turbopack, then `--webpack`, then Turbopack with the
database unreachable) and Alt + right-clicks through it in Chromium — also
after editing a route and a helper while the page is open (hot reload), and
knocking on the agent from the machine's LAN address. It's opt-in — the first
run installs Next into the copy (a few hundred MB, kept in `<tmp>/feel-next-e2e`
or `FEEL_E2E_DIR` for the next run) and Feel from packed tarballs:

```bash
FEEL_E2E=1 npm run test:e2e
```

Needs Postgres (`FEEL_E2E_DATABASE_URL`, default `postgres://feel@127.0.0.1:5499/feel`;
the test creates an `items` table) and a Chromium that matches the fixture's
`playwright-core` (`FEEL_E2E_CHROME`, default Playwright's under `/opt/pw-browsers`,
or `npx playwright-core install chromium`). `FEEL_E2E_VERBOSE=1` prints what the
panel showed. The fixture itself is only read.

## Adding support for a new library

Most support lives in the agent:

- **A new way of calling APIs** (like SWR or an axios instance) →
  `packages/agent/src/static.js` (`frontendCalls`) for the static side. The
  runtime side usually works already via fetch/XHR capture.
- **A new backend framework** → route scanning in `static.js` (`scanRoutes`)
  and handler lookup in `handler.js`, plus runtime instrumentation in
  `packages/node/`. File-based routes like Next's live in `next-routes.js`.
- **A new database layer** → `packages/node/` to record queries per request
  (an ORM on `pg` or `mysql2` usually works already — see `drizzle.js` for one
  that needs help finding your line), `packages/agent/src/sql.js` to find their
  tables,
  and `packages/agent/src/orm.js` for its calls in "possible calls".

## Reporting bugs

Use the bug report template — your stack details (Vite, data fetching,
backend, database, aliases) matter more than anything else.
