import { Router } from 'express';
import { prisma } from '../prisma.js';

const router = Router();

router.get('/', async (req, res) => {
  res.json(await prisma.customer.findMany({ include: { orders: true } }));
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  await prisma.orderItem.deleteMany({ where: { customerId: id } });
  await prisma.customer.delete({ where: { id } });
  res.status(204).end();
});

export default router;
