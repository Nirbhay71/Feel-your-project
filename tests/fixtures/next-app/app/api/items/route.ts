// GET /api/items — raw SQL through pg.
import { pool } from '../../../lib/db';

export const dynamic = 'force-dynamic';

const FALLBACK = [
  { id: 1, name: 'fallback one' },
  { id: 2, name: 'fallback two' },
];

export async function GET() {
  try {
    const { rows } = await pool.query('SELECT id, name FROM items ORDER BY id');
    return Response.json({ items: rows });
  } catch (err) {
    return Response.json({ items: FALLBACK, error: (err as Error).message }, { status: 500 });
  }
}
