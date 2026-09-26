import { Router } from 'express';
import { notifications } from '../data.js';

const router = Router();

// Style 3: handler defined as a function in the same file.
function listNotifications(req, res) {
  res.json(notifications);
}

router.get('/notifications', listNotifications);

export default router;
