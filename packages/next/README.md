# @feel-dev/next

**Alt + right-click any element in your Next.js app** and see the full stack behind it:

```
component → the JSX line that rendered it → the functions that fetched its data
  → route handler → SQL queries → tables (+ structure, related tables, recent changes)
```

Every step opens the actual code. The same panel as [`@feel-dev/vite-plugin`](../vite-plugin), for the Next.js App Router.

Dev only — `next build` / `next start` get none of it.

## Install

```bash
npm install -D @feel-dev/next
```

## Set up

**1. `next.config.mjs`** (or `.js` / `.ts`):

```js
import { withFeel } from '@feel-dev/next';

export default withFeel(
  { /* your Next config — an object or a (phase) => config function */ },
  { database: process.env.DATABASE_URL }, // optional, for the table view (Postgres)
);
```

Options: `database`, `projectRoot` (the folder holding frontend and backend, if not the nearest `.git`), `allowedHosts` (host names other than localhost that may reach Feel — defaults to your `allowedDevOrigins`), `allowedAddresses` (IP addresses of other machines that may use Feel, e.g. your phone on the same Wi-Fi — none by default).

`withFeel` returns a config *function* (Next calls it with the phase), so put it outermost: `withFeel(withOtherPlugin(config))`.

**2. `instrumentation.js`** in your project root (or `src/`) — records each route handler's SQL:

```js
export async function register() {
  if (process.env.NODE_ENV === 'development' && process.env.NEXT_RUNTIME === 'nodejs') {
    await import('@feel-dev/next/register');
  }
}
```

**3. `instrumentation-client.js`** next to it — the browser side (Next runs it before your app, so every request is seen):

```js
import '@feel-dev/next/client';
```

**4. The agent route**: `app/%5F%5Ffeel/[...path]/route.js` (the folder is `__feel` URL-escaped — Next never routes folders starting with `_`):

```js
export { GET, POST } from '@feel-dev/next/agent';
```

Then `next dev` (Turbopack) or `next dev --webpack`, **hold Alt** and **Alt + right-click**.

## What it does

- **Tags** every DOM element in your components with `data-src="file:line:col|Component"` — client and Server Components alike, so hydration sees the same markup — and tags components so the chain shows yours, not Next's.
- **Maps browser stack traces** through Next's own sourcemaps (Turbopack chunk maps or webpack's `/__nextjs_source-map`), so each request shows the function and line that made it.
- **Wraps Route Handlers** (`app/**/route.ts`, every exported `GET`/`POST`/…) and Pages Router API routes (`pages/api/**`): each response carries an `X-Feel-Route` header with the handler and the SQL it ran (raw `pg`, `mysql2`, Prisma, Drizzle — see [`@feel-dev/node`](../node)), with the line in your code, not in `.next/`.
- **Possible calls**: `fetch('/api/items/' + id)` in a component is matched to `app/api/items/[id]/route.ts` from code alone, with the tables its handler touches.
- Keeps Feel, `drizzle-orm` and `mysql2` in `serverExternalPackages`, so `instrumentation.js` and your routes share one patched copy.

## Security

The agent route reads your source code, so it answers only when all of these hold:

- `next dev` with `withFeel` — under `next start` it's a 404 (and the production build carries nothing of Feel's but that 404)
- the connection comes from this machine — `next dev` listens on your whole network, but Feel checks the socket's own address, which a client can't fake (`Host` and `X-Forwarded-For` can be). Other machines only with `allowedAddresses`
- the `Host` is this machine (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`) or in `allowedHosts` — this blocks DNS rebinding
- the request comes from the page itself (same `Origin`; POSTs need an `X-Feel` header)

## Not yet

Server Actions, data fetched inside Server Components (no browser request to follow), `middleware.ts` / `proxy.ts`, the edge runtime, Next before 16.

Known limits:

- Route handlers exported as `export * from './handlers'`, or as `export let GET` reassigned later, aren't instrumented (`export const { GET, POST } = handlers` and `export { GET } from './x'` are).
- A Server Component that renders a client component isn't in the component chain; elements it renders directly are tagged, and children passed down show under the component that renders them.
- `output: 'export'` isn't supported (the agent route is dynamic).
- `next dev --experimental-https`: the self-signed certificate stops Feel from fetching sourcemaps, so browser frames aren't mapped.

## Requirements

- Next.js 16+, App Router, React 19
- Node 20.19+
