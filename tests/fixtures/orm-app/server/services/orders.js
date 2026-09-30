import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import * as schema from '../db/schema/index.js';

export async function placeOrder({ userId, productId }) {
  const [order] = await db.insert(schema.orders).values({ userId, productId }).returning();
  await db.update(schema.products).set({ stock: sql`stock - 1` }).where(eq(schema.products.id, productId));
  return order;
}
