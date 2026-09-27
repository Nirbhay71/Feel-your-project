# @feel/node

Backend half of Feel (setup guide: `@feel/vite-plugin`). Tells the browser, for every request:

- which **Express route and handler** answered it (file and line where it was registered)
- which **SQL queries** it ran through `pg`, and the line in your code that sent each one
- a request id, which Postgres change tracking uses to link row changes back to the request

## Use

First line of your server entry file:

```js
import '@feel/node/register';        // ES modules
require('@feel/node/register');      // CommonJS (Node 20.19+)
```

Express and `pg` are patched only if they're installed. Does nothing when `NODE_ENV=production`.

## How it reports

A response header, read by the Feel browser panel:

```
X-Feel-Route: {"id":"…","method":"GET","path":"/api/stats","handlers":[…],"queries":[…]}
```

`Access-Control-Expose-Headers` is set too, so it also works when the API is on another origin.
