-- Demo schema + seed data. Runs once when the container is first created.
-- To start over:  npm run db:reset

CREATE TABLE users (
  id         serial PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id    serial PRIMARY KEY,
  name  text NOT NULL,
  price numeric(10, 2) NOT NULL
);

CREATE TABLE orders (
  id         serial PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users (id),
  product_id integer NOT NULL REFERENCES products (id),
  amount     numeric(10, 2) NOT NULL,
  status     text NOT NULL DEFAULT 'paid',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id         serial PRIMARY KEY,
  text       text NOT NULL,
  order_id   integer REFERENCES orders (id),
  user_id    integer REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO users (email, name) VALUES
  ('jane@example.com', 'Jane'),
  ('ravi@example.com', 'Ravi'),
  ('mei@example.com', 'Mei'),
  ('omar@example.com', 'Omar'),
  ('lena@example.com', 'Lena');

INSERT INTO products (name, price) VALUES
  ('Keyboard', 49.00),
  ('Mouse', 19.00),
  ('Monitor', 199.00),
  ('Headphones', 89.00);

-- ~40 orders spread over the last 7 days.
INSERT INTO orders (user_id, product_id, amount, created_at)
SELECT u, p, pr.price, now() - (d || ' days')::interval - (h || ' hours')::interval
FROM generate_series(0, 6) AS d,
     generate_series(1, 6) AS h,
     LATERAL (SELECT 1 + (d * 7 + h) % 5 AS u, 1 + (d + h) % 4 AS p) AS pick
     JOIN products pr ON pr.id = pick.p
WHERE (d + h) % 7 <> 0;

INSERT INTO notifications (text, user_id, created_at) VALUES
  ('User jane@example.com signed up', 1, now() - interval '3 days'),
  ('Payment of $199 received', 3, now() - interval '1 day'),
  ('Low stock: Monitor', NULL, now() - interval '2 hours');
