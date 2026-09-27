# Feel

Alt + right-click any UI element to see the full stack behind it:
component → frontend code → API route → backend handler → SQL → tables.

**Setup guide for your own app: [packages/vite-plugin/README.md](packages/vite-plugin/README.md)**

## Layout

| Folder                 | Package             | What it is                                                                 |
| ---------------------- | ------------------- | -------------------------------------------------------------------------- |
| `packages/vite-plugin` | `@feel/vite-plugin` | What you install: tags JSX, injects the client, mounts the agent           |
| `packages/client`      | `@feel/client`      | Browser: selection, request capture, viewer panel (installed by the plugin) |
| `packages/agent`       | `@feel/agent`       | Node side in Vite dev: code, stack mapping, call graph, SQL + DB (installed by the plugin) |
| `packages/node`        | `@feel/node`        | Backend: Express + pg instrumentation                                      |
| `demo`                 | —                   | React dashboard + Express API + Postgres (Docker) to try it on            |

## Run the demo

Needs Docker Desktop running.

```bash
npm install
npm run db          # Postgres on :5433 (first run seeds it)
npm run demo        # API on :3001 + Vite on :5173
```

`npm run db:reset` wipes the database and re-seeds it (also removes change tracking).

## Try it in another app without publishing

```bash
npm run pack        # → packs/*.tgz
```

Then in the other app:

```bash
npm install -D <path>/packs/feel-agent-0.1.0.tgz <path>/packs/feel-client-0.1.0.tgz <path>/packs/feel-vite-plugin-0.1.0.tgz <path>/packs/feel-node-0.1.0.tgz
```
