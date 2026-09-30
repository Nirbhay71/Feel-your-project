// One pg pool for the app, and Drizzle on top of it.
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://feel@127.0.0.1:5499/feel',
  connectionTimeoutMillis: 2000,
});

export const db = drizzle(pool);
