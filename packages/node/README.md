# @feel-dev/node

Backend half of Feel (setup guide: `@feel-dev/vite-plugin`). Tells the browser, for every request:

- which **Express route and handler** answered it (file and line where it was registered)
- which **SQL queries** it ran through `pg`, and the line in your code that sent each one —
  also when an ORM sends them: **Prisma** (7, or 6 with `@prisma/adapter-pg`), **Drizzle**
  (`drizzle-orm/node-postgres`), and Knex, Sequelize, TypeORM, … on `pg`
- a request id, which Postgres change tracking uses to link row changes back to the request

## Use

First line of your server entry file:

```js
import '@feel-dev/node/register';        // ES modules
require('@feel-dev/node/register');      // CommonJS (Node 20.19+)
```

Express, `pg` and Drizzle are patched only if they're installed. Does nothing when `NODE_ENV=production`.

## ORMs

Nothing to configure — ORMs that talk to Postgres through `pg` are picked up automatically.

- **Prisma** sends each query many awaits away from your code. Feel follows Node's async
  stack frames back to your `prisma.user.findMany()` line. Batch transactions
  (`prisma.$transaction([…])`) run on their own connection, so their queries show the SQL
  and tables, marked "ORM", without a line.
- **Drizzle** queries are lazy: `db.select().from(users)` builds the query, `await` sends it
  later from an empty stack. Feel notes the line when you call `db.select()` / `db.insert()` /
  `db.query.users.findMany()` / … and hands it to the query when it runs.
- **Other ORMs on `pg`** show their SQL and tables; the line is found when the ORM keeps your
  code on the async stack, otherwise the query is marked "ORM".

## How it reports

A response header, read by the Feel browser panel:

```
X-Feel-Route: {"id":"…","method":"GET","path":"/api/stats","handlers":[…],"queries":[…]}
```

`Access-Control-Expose-Headers` is set too, so it also works when the API is on another origin.
