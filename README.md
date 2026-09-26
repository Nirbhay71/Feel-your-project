# Feel

Alt + right-click any UI element to see the full stack behind it:
frontend file/function/line → backend route/handler → database table.

## Layout

| Folder                 | What it is                                                      |
| ---------------------- | --------------------------------------------------------------- |
| `packages/vite-plugin` | Piece 1 — tags every JSX element with `data-src` at build time  |
| `packages/client`      | Piece 2 + 4 — right-click handler and viewer panel (in browser) |
| `packages/agent`       | Piece 3 — local Node server that reads source files             |
| `demo`                 | Sample React dashboard to test on                               |

## Run

```bash
npm install
npm run demo
```
