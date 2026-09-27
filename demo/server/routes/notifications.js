import { Router } from 'express';
import { pool } from '#db';

const router = Router();

// Style 3: handler defined as a function in the same file.
async function listNotifications(req, res) {
  const { rows } = await pool.query(
    'SELECT id, text, created_at FROM notifications ORDER BY created_at DESC LIMIT 5',
  );
  res.json(rows);
}

router.get('/notifications', listNotifications);

router.delete('/notifications/:id', async (req, res) => {
  await pool.query('DELETE FROM notifications WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

export default router;
