# Feel

Alt + right-click any UI element to see the full stack behind it:
frontend file/function/line → backend route/handler → SQL query → database table.

## Layout

| Folder                 | What it is                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `packages/vite-plugin` | Tags every JSX element with `data-src`, injects the client, mounts the agent        |
| `packages/client`      | Browser: Alt + right-click, fetch/XHR capture, viewer panel                         |
| `packages/agent`       | Node side (in Vite dev): source code, stack mapping, call graph, SQL + DB inspection |
| `packages/node`        | Backend: patches Express + pg to report route, handler and queries per request      |
| `demo`                 | React dashboard (`src/`) + Express API (`server/`) + Postgres (`db/`, Docker)       |

## Run the demo

Needs Docker Desktop running.

```bash
npm install
npm run db          # Postgres on :5433 (first run seeds it)
npm run demo        # API on :3001 + Vite on :5173
```

`npm run db:reset` wipes the database and re-seeds it (also removes change tracking).

## Using it in your app (dev only)

```js
// vite.config.js
plugins: [feel({ database: process.env.DATABASE_URL }), react()]

// first line of your server entry
import '@feel/node/register';
```
