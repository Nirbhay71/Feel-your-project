// mysql2 on the backend: raw pool.execute / pool.query, and Drizzle's mysql2 driver.
export function Users() {
  const load = () => fetch('/api/users').then((r) => r.json());
  const stats = () => fetch('/api/stats').then((r) => r.json());
  const lookup = () => fetch('/api/lookup').then((r) => r.json());
  return [load, stats, lookup];
}
