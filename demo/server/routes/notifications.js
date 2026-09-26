import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

// Style 3: handler defined as a function in the same file.
async function listNotifications(req, res) {
  const { rows } = await pool.query(
    'SELECT id, text, created_at FROM notifications ORDER BY created_at DESC LIMIT 5',
  );
  res.json(rows);
}

router.get('/notifications', listNotifications);

export default router;
