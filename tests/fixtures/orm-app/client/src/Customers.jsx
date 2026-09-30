import { getJson } from './api.js';

// Prisma on the backend.
export function Customers() {
  const load = () => getJson('/api/customers');
  const remove = (id) => getJson(`/api/customers/${id}`, { method: 'DELETE' });
  return [load, remove];
}
