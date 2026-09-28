# Security

Feel runs **only in development** — the Vite plugin does nothing in production
builds, and `@feel/node` does nothing when `NODE_ENV=production`. While your
dev server runs, it can read your source code and your database, so it's
built to be careful:

- Only source files (`.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`) inside your
  project folder are ever read — never `.env`, config or files in
  `node_modules`.
- Requests to Feel from other websites open in the same browser are refused
  (origin check), and anything that changes state needs a header other sites
  can't send.
- Database access is read-only, except "Turn on change tracking", which you
  click yourself; table names are always quoted.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository. Include the steps to
reproduce and what an attacker could do. You'll get a reply as soon as possible.
