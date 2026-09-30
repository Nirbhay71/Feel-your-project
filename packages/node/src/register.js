// Side-effect entry point. Put this as the FIRST import of your server:
//
//   import '@feel-dev/node/register';
//
// It patches Express, pg and Drizzle (whichever are installed) before your
// own files run. Does nothing in production.

import { createRequire } from 'node:module';
import { instrumentExpress, instrumentPg, instrumentDrizzle } from './index.js';

const DIALECTS = ['pg-core', 'mysql-core', 'sqlite-core'];

if (process.env.NODE_ENV !== 'production') {
  // require() is synchronous, so the patches are in place before the next
  // import in your server file runs. Both packages are CommonJS, so this is
  // the same instance your `import express from 'express'` gets.
  const require = createRequire(import.meta.url);
  const tryRequire = (name) => {
    try {
      return require(name);
    } catch {
      return null; // not installed — skip
    }
  };

  const express = tryRequire('express');
  if (express) instrumentExpress(express);

  const pg = tryRequire('pg');
  if (pg) instrumentPg(pg);

  // Drizzle ships two copies: CommonJS for require(), ES modules for import.
  // Patch both — whichever your server uses. The ES copy loads
  // asynchronously, which is fine: it's in place long before the first
  // request arrives. (A top-level await here would break require().)
  const drizzle = (load) => ({
    dialects: DIALECTS.map((d) => load(`drizzle-orm/${d}`)),
    relational: DIALECTS.map((d) => load(`drizzle-orm/${d}/query-builders/query`)),
  });
  if (tryRequire('drizzle-orm')) {
    instrumentDrizzle(drizzle(tryRequire));
    const tryImport = (name) => import(name).catch(() => null);
    const esm = drizzle(tryImport);
    Promise.all([...esm.dialects, ...esm.relational])
      .then((mods) => instrumentDrizzle({ dialects: mods.slice(0, DIALECTS.length), relational: mods.slice(DIALECTS.length) }))
      .catch(() => {});
  }
}
