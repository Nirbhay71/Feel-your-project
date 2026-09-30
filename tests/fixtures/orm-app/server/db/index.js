import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.js';

export const db = drizzle(new pg.Pool({ connectionString: process.env.DATABASE_URL }), { schema });
