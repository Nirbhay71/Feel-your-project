import { Router } from 'express';
import { getStats } from '../controllers/stats.js';

const router = Router();

// Style 1: handler imported from a controller file.
router.get('/stats', getStats);

export default router;
