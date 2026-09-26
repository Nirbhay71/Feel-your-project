import { Router } from 'express';
import { sales } from '../data.js';

const router = Router();

// Style 2: inline handler.
router.get('/sales', (req, res) => {
  res.json(sales);
});

export default router;
