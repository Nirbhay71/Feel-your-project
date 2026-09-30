import { pgTable, serial, integer } from 'drizzle-orm/pg-core';

export const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  userId: integer('user_id'),
  productId: integer('product_id'),
});

export const products = pgTable('products', {
  id: serial('id').primaryKey(),
  stock: integer('stock'),
});
