// In-memory data for now. Layer 3 replaces this with Postgres.

export const stats = { users: 1204, orders: 312, revenue: 8450 };

export const sales = [
  { day: 'Mon', sales: 120 },
  { day: 'Tue', sales: 180 },
  { day: 'Wed', sales: 150 },
  { day: 'Thu', sales: 220 },
  { day: 'Fri', sales: 260 },
];

export const notifications = [
  { id: 1, text: 'New order #312 placed' },
  { id: 2, text: 'User jane@example.com signed up' },
  { id: 3, text: 'Payment of $120 received' },
];
