# @feel-dev/agent

Internal part of Feel (setup guide: `@feel-dev/vite-plugin`) — installed and used by `@feel-dev/vite-plugin` and `@feel-dev/next`, not directly.

Runs inside the Vite dev server at `/__feel/*`: source lookup, mapping browser stack traces through Vite's sourcemaps, the static call graph, "possible calls", SQL table extraction and Postgres inspection.
