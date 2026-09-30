import { pgTable, serial, text } from 'drizzle-orm/pg-core';

export const users = pgTable('app_users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
});
