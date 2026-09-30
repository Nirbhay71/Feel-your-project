import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { pool, db, orders } from '../db/index.js';

const router = Router();
const bus = { execute: (name) => name };

router.get('/users', async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM users');
  bus.execute('RefreshUsers'); // not SQL
  bus.execute('delete-user'); // not SQL either, though it starts with "delete"
  res.json(rows);
});

router.get('/stats', async (req, res) => {
  await db.execute(sql`SELECT count(*) FROM secret_table`); // Drizzle's sql`` — not raw text
  res.json(await db.select().from(orders));
});

router.get('/lookup', async (req, res) => {
  const [rows] = await pool.query({ sql: 'SELECT * FROM `products` WHERE id = ?', values: [1] });
  await pool.execute(`UPDATE users SET seen = 1`);
  await pool.execute('CALL refresh_stats(?)', [1]);
  await pool.query('(SELECT id FROM archived_orders) UNION (SELECT id FROM orders)');
  res.json(rows);
});

export default router;
