import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

// Style 2: inline handler.
router.get('/sales', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT to_char(date_trunc('day', created_at), 'Dy') AS day,
           sum(amount)::int                           AS sales
    FROM orders
    WHERE created_at > now() - interval '7 days'
    GROUP BY date_trunc('day', created_at)
    ORDER BY date_trunc('day', created_at)
  `);
  res.json(rows);
});

export default router;
