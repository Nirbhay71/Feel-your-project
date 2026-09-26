import { pool } from '../db.js';

export async function getStats(req, res) {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*) FROM users)::int                  AS users,
      (SELECT count(*) FROM orders)::int                 AS orders,
      (SELECT coalesce(sum(amount), 0) FROM orders)::int AS revenue
  `);
  res.json(rows[0]);
}
