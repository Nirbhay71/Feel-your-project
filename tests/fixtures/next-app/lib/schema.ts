// Drizzle schema for the items table.
import { pgTable, serial, text } from 'drizzle-orm/pg-core';

export const items = pgTable('items', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
});
