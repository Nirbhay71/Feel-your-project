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

// --- Postgres SQL that only the regex understood keeps its answer ---------------

test('Postgres operators like #> still fall back to the same regex', () => {
  assert.deepEqual(tables("SELECT data #> '{a,b}' AS x FROM docs JOIN users ON true"), { docs: 'read', users: 'read' });
});

// --- MySQL / MariaDB (mysql2) -----------------------------------------------------

test('MySQL: backticks, ? placeholders and ON DUPLICATE KEY UPDATE', () => {
  assert.deepEqual(tables('INSERT INTO `t` (a) VALUES (?) ON DUPLICATE KEY UPDATE a = VALUES(a)'), { t: 'write' });
  assert.deepEqual(tables('INSERT INTO `t` (name) VALUES (?) ON DUPLICATE KEY UPDATE name = ?'), { t: 'write' });
});

test('MySQL: quoted aliases and JOINs read both sides', () => {
  assert.deepEqual(tables('SELECT `u`.`id` FROM `users` `u` JOIN `orders` ON `orders`.`user_id` = `u`.`id`'), { users: 'read', orders: 'read' });
});

test('MySQL: DELETE / UPDATE with ORDER BY … LIMIT and modifiers', () => {
  assert.deepEqual(tables('DELETE FROM `orders` WHERE id = ? LIMIT 1'), { orders: 'write' });
  assert.deepEqual(tables('UPDATE LOW_PRIORITY users SET a = 1 ORDER BY id LIMIT 1'), { users: 'write' });
});

test('MySQL: INSERT IGNORE and REPLACE write their table', () => {
  assert.deepEqual(tables('INSERT IGNORE INTO users (name) VALUES (?)'), { users: 'write' });
  assert.deepEqual(tables('REPLACE INTO users (id, name) VALUES (?, ?)'), { users: 'write' });
});

test('MySQL: db.table and LIMIT offset, count', () => {
  assert.deepEqual(tables('SELECT * FROM feel.users LIMIT 10, 20'), { users: 'read' });
});

test('MySQL: multi-table UPDATE / DELETE write the first table, read the rest', () => {
  assert.deepEqual(tables('UPDATE users u JOIN orders o ON o.user_id = u.id SET u.a = 1'), { users: 'write', orders: 'read' });
  assert.deepEqual(tables('DELETE o FROM orders o JOIN users u ON u.id = o.user_id WHERE u.id = ?'), { orders: 'write', users: 'read' });
});

test('MySQL: string literals never count as SQL', () => {
  assert.deepEqual(tables("SELECT '`x` ? ON DUPLICATE KEY UPDATE y' FROM `a`"), { a: 'read' });
  assert.deepEqual(tables('SELECT "a\\"b" FROM `users` WHERE x = ?'), { users: 'read' });
});

test('MySQL: DUAL is not a table', () => {
  assert.deepEqual(tables('SELECT 1 FROM DUAL'), {});
});

test('MySQL: ?? (identifier) and :name placeholders', () => {
  assert.deepEqual(tables('SELECT * FROM ?? WHERE id = ?'), {});
  assert.deepEqual(tables('SELECT ?? FROM users WHERE id = ?'), { users: 'read' });
  assert.deepEqual(tables('SELECT * FROM users WHERE id = :id AND name = :name'), { users: 'read' });
});

test('MySQL: tables read inside ON DUPLICATE KEY UPDATE still count', () => {
  assert.deepEqual(tables('INSERT INTO totals (id, n) VALUES (?, 1) ON DUPLICATE KEY UPDATE n = (SELECT count(*) FROM orders o JOIN users u ON u.id = o.user_id)'), {
    totals: 'write',
    orders: 'read',
    users: 'read',
  });
  assert.deepEqual(tables('INSERT INTO `t` (a, b) VALUES (?, ?) ON DUPLICATE KEY UPDATE a = VALUES(a), b = b + 1'), { t: 'write' });
});

test('MySQL: STRAIGHT_JOIN, multi-table DELETE and UPDATE / DELETE … LIMIT without ? or backticks', () => {
  assert.deepEqual(tables('SELECT STRAIGHT_JOIN u.id FROM users u STRAIGHT_JOIN orders o ON o.user_id = u.id'), { users: 'read', orders: 'read' });
  assert.deepEqual(tables('DELETE o, i FROM orders o JOIN items i ON i.order_id = o.id WHERE o.id = 1'), { orders: 'write', items: 'read' });
  assert.deepEqual(tables('DELETE FROM sessions WHERE expired = 1 ORDER BY id LIMIT 100'), { sessions: 'write' });
  assert.deepEqual(tables('UPDATE jobs SET taken = 1 WHERE taken = 0 LIMIT 1'), { jobs: 'write' });
});

test('MySQL: UPDATE with a comma list writes every table before SET', () => {
  assert.deepEqual(tables('UPDATE users, orders SET users.a = 1, orders.b = 2 WHERE orders.user_id = users.id'), { users: 'write', orders: 'write' });
  assert.deepEqual(tables('UPDATE `users` u, feel.orders o SET u.a = ? WHERE o.user_id = u.id'), { users: 'write', orders: 'write' });
});

test('SELECT … FOR UPDATE is a lock, not a table', () => {
  assert.deepEqual(tables('SELECT * FROM `jobs` WHERE id = ? FOR UPDATE'), { jobs: 'read' });
});

test('huge or adversarial SQL finishes quickly', () => {
  const spaces = ' '.repeat(50000);
  const inputs = [
    `UPDATE t SET a = ? ORDER BY${spaces}x`,
    `UPDATE t SET a = ?${spaces}x`,
    `INSERT INTO t VALUES (?) ON${spaces}x`,
    `SELECT * FROM t WHERE a = ? LIMIT 1${spaces}x`,
    `SELECT ? FROM t FOR${spaces}UPDATE of x`,
    `SELECT * FROM t WHERE${spaces}x ~~~ y`,
    `UPDATE t${spaces},`,
    `DELETE FROM t WHERE ?${spaces}LIMIT`,
    `SELECT ? FROM t WHERE a = '${"''".repeat(25000)}`,
    `SELECT ? ${'FROM a '.repeat(7000)}`,
    `INSERT${' IGNORE'.repeat(7000)} x ?`,
  ];
  for (const sql of inputs) {
    const start = performance.now();
    tablesInSql(sql);
    const ms = performance.now() - start;
    assert.ok(ms < 200, `${ms.toFixed(0)} ms for ${sql.slice(0, 40).trim()}…`);
  }
});
