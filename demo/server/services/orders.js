import { pool } from '#db';

// Places an order for a random user/product and writes a notification for it —
// two tables change, linked by notifications.order_id → orders.id.
export async function createOrder() {
  const { rows } = await pool.query(`
    INSERT INTO orders (user_id, product_id, amount)
    SELECT u.id, p.id, p.price
    FROM (SELECT id FROM users ORDER BY random() LIMIT 1) u,
         (SELECT id, price FROM products ORDER BY random() LIMIT 1) p
    RETURNING id, user_id, amount
  `);
  const order = rows[0];

  await pool.query(
    'INSERT INTO notifications (text, order_id, user_id) VALUES ($1, $2, $3)',
    [`New order #${order.id} placed ($${order.amount})`, order.id, order.user_id],
  );

  return order;
}
