import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { mysqlTable, int } from 'drizzle-orm/mysql-core';

export const pool = mysql.createPool(process.env.DATABASE_URL);
export const orders = mysqlTable('orders', { id: int('id').primaryKey() });
export const db = drizzle(pool, { schema: { orders }, mode: 'default' });
