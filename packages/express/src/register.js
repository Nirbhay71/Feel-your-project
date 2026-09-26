// Side-effect entry point. Put this as the FIRST import of your server:
//
//   import '@feel/express/register';
//
// It patches Express before your route files run. Does nothing in production.

import express from 'express';
import { instrument } from './index.js';

if (process.env.NODE_ENV !== 'production') instrument(express);
