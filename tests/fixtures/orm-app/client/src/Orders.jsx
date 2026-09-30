import { getJson } from './api.js';

// Drizzle on the backend.
export function Orders() {
  const load = () => getJson('/api/orders');
  const place = () => getJson('/api/orders', { method: 'POST' });
  const owner = (id) => getJson(`/api/users/${id}`);
  return [load, place, owner];
}
