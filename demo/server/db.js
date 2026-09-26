import pg from 'pg';

// DATABASE_URL comes from demo/.env (loaded by `node --env-file`).
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
