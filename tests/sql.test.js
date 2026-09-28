// Which tables a SQL statement touches, and whether it reads or writes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tablesInSql } from '../packages/agent/src/sql.js';

const tables = (sql) => Object.fromEntries(tablesInSql(sql).map((t) => [t.name, t.access]));

test('SELECT with subqueries reads every table', () => {
  assert.deepEqual(tables('SELECT (SELECT count(*) FROM users) AS u, (SELECT sum(amount) FROM orders) AS r'), { users: 'read', orders: 'read' });
});

test('INSERT … SELECT writes the target and reads the sources', () => {
  const sql = `INSERT INTO orders (user_id, product_id, amount)
    SELECT u.id, p.id, p.price
    FROM (SELECT id FROM users ORDER BY random() LIMIT 1) u,
         (SELECT id, price FROM products ORDER BY random() LIMIT 1) p
    RETURNING id`;
  assert.deepEqual(tables(sql), { orders: 'write', users: 'read', products: 'read' });
});

test('UPDATE / DELETE with placeholders write their table', () => {
  assert.deepEqual(tables('UPDATE users SET name = $1 WHERE id = $2'), { users: 'write' });
  assert.deepEqual(tables('DELETE FROM notifications WHERE id = $1'), { notifications: 'write' });
});

test('JOINs read both sides', () => {
  assert.deepEqual(tables('SELECT p.name FROM products p LEFT JOIN orders o ON o.product_id = p.id'), { products: 'read', orders: 'read' });
});

test('CTE names are not tables', () => {
  assert.deepEqual(tables('WITH recent AS (SELECT * FROM orders) UPDATE users SET name = $1 FROM recent WHERE users.id = recent.user_id'), {
    orders: 'read',
    users: 'write',
  });
});

test('unparseable SQL falls back to a regex instead of failing', () => {
  assert.deepEqual(tables('SELECT *** FROM weird_table JOIN other ON ???'), { weird_table: 'read', other: 'read' });
});
