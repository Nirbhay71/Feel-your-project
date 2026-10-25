# @feel-dev/init

Set up Feel in a React + Vite app, a Next.js 16+ App Router app, and an optional Express backend.

```bash
npx @feel-dev/init
```

Run from the app or workspace root. The command detects packages, asks you to choose when there are multiple apps or backends, and shows the planned edits and npm installs before applying them. Existing files receive `.feel-backup` copies. Running setup again does not add duplicate imports or plugins.

```bash
npx @feel-dev/init --app apps/web --backend apps/api --dry-run
npx @feel-dev/init --app apps/web --backend apps/api --yes
npx @feel-dev/init --no-backend --no-install
```

`--dry-run` writes and installs nothing. `--yes` accepts the shown plan; it does not guess which app to configure. `--no-install` leaves dependency installation to you. Automatic dependency installation uses npm; with other package managers use `--no-install` and install the listed packages with your project's package manager.

Vite setup preserves existing plugins and puts Feel first. Next setup wraps the existing config, adds the development registration, imports the client and creates the agent route under `app/` or `src/app/`. Express registration is placed before the other imports in a recognized server entry.

Unusual configs, existing agent routes and instrumentation that cannot be merged safely receive manual instructions. Existing contents are preserved. Exit code 2 means edits were applied but manual steps remain; exit code 1 reports an error. If a file changes after preview, setup stops before writing.

Database inspection is optional. Setup never reads `.env` or embeds credentials in generated files. Configure Feel's `database` option separately if you want table structure. After restarting the dev server, Alt + right-click a component and expand **Setup checks** to inspect agent availability, frontend compatibility, observed backend metadata and SQL, and the optional Postgres connection.
