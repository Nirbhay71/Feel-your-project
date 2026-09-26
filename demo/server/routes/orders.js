import { Router } from 'express';
import { createOrder } from '../services/orders.js';

const router = Router();

// Handler → service → db: the queries run two files away from the route.
router.post('/orders', async (req, res) => {
  const order = await createOrder();
  res.status(201).json(order);
});

export default router;
