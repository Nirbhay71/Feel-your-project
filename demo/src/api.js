import { api } from './lib/http.js';

async function getJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

// fetch + a wrapper (used with the useApi hook)
export const fetchStats = () => getJson('/api/stats');

// axios instance (used with React Query)
export const fetchSales = () => api.get('/sales').then((res) => res.data);
export const placeOrder = () => api.post('/orders').then((res) => res.data);

// Components that don't use React Query re-fetch when this fires
// (see useApi / Notifications).
export const notifyDataChanged = () => window.dispatchEvent(new Event('app:refresh'));
