// Side-effect entry point. Put this as the FIRST import of your server:
//
//   import '@feel/node/register';
//
// It patches Express and pg (whichever are installed) before your own files
// run. Does nothing in production.

import { createRequire } from 'node:module';
import { instrumentExpress, instrumentPg } from './index.js';

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
}
