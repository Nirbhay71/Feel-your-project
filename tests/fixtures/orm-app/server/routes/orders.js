import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { orders, users } from '../db/schema/index.js';
import { placeOrder } from '../services/orders.js';

const router = Router();
const sessions = new Map();

router.get('/orders', async (req, res) => {
  const rows = await db
    .select()
    .from(orders)
    .leftJoin(users, eq(orders.userId, users.id));
  res.json(rows);
});

router.post('/orders', async (req, res) => {
  sessions.delete(req.ip); // a Map, not a table
  res.json(await placeOrder(req.body));
});

router.get('/users/:id', async (req, res) => {
  res.json(await db.query.users.findFirst({ where: eq(users.id, Number(req.params.id)) }));
});

export default router;
