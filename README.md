# Feel

Alt + right-click any UI element to see the full stack behind it:
frontend file/function/line → backend route/handler → database table.

## Layout

| Folder                 | What it is                                                      |
| ---------------------- | --------------------------------------------------------------- |
| `packages/vite-plugin` | Piece 1 — tags every JSX element with `data-src` at build time  |
| `packages/client`      | Piece 2 + 4 — right-click handler and viewer panel (in browser) |
| `packages/agent`       | Node side (mounted in Vite dev): source code, stack mapping, static call graph, route → handler |
| `packages/express`     | Layer 2 — tells the browser which route/handler answered a request |
| `demo`                 | Sample React dashboard (`src/`) + Express API (`server/`)       |

## Run

```bash
npm install
npm run demo        # API on :3001 + Vite on :5173
```
