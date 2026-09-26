import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

router.get('/products/top', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.name, count(o.id)::int AS orders, coalesce(sum(o.amount), 0)::int AS revenue
    FROM products p
    LEFT JOIN orders o ON o.product_id = p.id
    GROUP BY p.id
    ORDER BY revenue DESC
    LIMIT 4
  `);
  res.json(rows);
});

export default router;
