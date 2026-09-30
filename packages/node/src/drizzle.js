// Drizzle: remember which line of your code built each query.
//
// The SQL itself is already caught by the pg or mysql2 patch — Drizzle
// sends it through that driver. What's missing is the line. Drizzle
// queries are lazy:
//
//   const rows = await db.select().from(users).where(…);   // users.js:12
//
// builds a query object on that line, and `await` calls its then() later,
// from an empty stack. So by the time the driver sees the SQL, users.js:12
// is gone.
//
// Fix: when your code calls db.select() / db.insert() / db.query.x.findMany()
// / …, note the line and attach it to the query object that comes out of the
// chain. When that object is awaited, put the line in siteStore, where
// callerSite() finds it (see context.js).

import { callerSite, siteStore } from './context.js';

const sites = new WeakMap(); // query object → { file, line, column }

// Chains are short: db.select() → .from() → awaitable. db.with(…).select()
// → .from() is the longest. A little headroom, then stop wrapping.
const MAX_HOPS = 4;

// mods: { dialects: ['drizzle-orm/pg-core', …], relational: ['drizzle-orm/pg-core/query-builders/query', …] }
// already loaded — either the CommonJS or the ES module copies.
export function instrumentDrizzle({ dialects = [], relational = [] }) {
  // PgDatabase, MySqlDatabase, BaseSQLiteDatabase — transactions extend them.
  for (const mod of dialects) {
    for (const Db of Object.values(mod ?? {})) {
      if (typeof Db === 'function' && /Database$/.test(Db.name) && Db.prototype) patchEntries(Db.prototype);
    }
  }
  // db.query.users.findMany() / findFirst()
  for (const mod of relational) {
    if (mod?.RelationalQueryBuilder) patchEntries(mod.RelationalQueryBuilder.prototype);
  }
}

function patchEntries(proto) {
  if (Object.hasOwn(proto, '__feelPatched')) return;
  proto.__feelPatched = true;
  for (const name of Object.getOwnPropertyNames(proto)) {
    const original = Object.getOwnPropertyDescriptor(proto, name).value;
    if (name === 'constructor' || typeof original !== 'function') continue;
    proto[name] = function (...args) {
      const site = callerSite();
      const result = original.apply(this, args);
      return site.file ? follow(result, site, 0) : result;
    };
  }
}

// Something you can await gets the line. Anything else is a builder on the
// way there (db.select() before .from()), so the next call on it is followed.
function follow(value, site, hops) {
  if (!value || typeof value !== 'object') return value;
  if (typeof value.then === 'function') {
    if (value instanceof Promise) return value; // already running — the line was on the stack
    sites.set(value, site);
    patchThen(value);
    return value;
  }
  if (hops >= MAX_HOPS) return value;
  return new Proxy(value, {
    get(target, key) {
      const v = Reflect.get(target, key, target);
      if (typeof v !== 'function' || key === 'constructor') return v;
      return (...args) => follow(v.apply(target, args), site, hops + 1);
    },
  });
}

// Drizzle copies then() onto each builder class (mixins), so patch the
// prototype that actually owns it, the first time we meet one.
function patchThen(query) {
  let proto = Object.getPrototypeOf(query);
  while (proto && !Object.hasOwn(proto, 'then')) proto = Object.getPrototypeOf(proto);
  if (!proto || proto.then.__feel) return;
  const then = proto.then;
  proto.then = function (onFulfilled, onRejected) {
    const site = sites.get(this);
    return site ? siteStore.run(site, () => then.call(this, onFulfilled, onRejected)) : then.call(this, onFulfilled, onRejected);
  };
  proto.then.__feel = true;
}
