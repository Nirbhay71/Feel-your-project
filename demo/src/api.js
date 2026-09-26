async function getJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

export const fetchStats = () => getJson('/api/stats');
export const fetchSales = () => getJson('/api/sales');
export const placeOrder = () => getJson('/api/orders', { method: 'POST' });

// Components re-fetch when this fires (see useApi / Notifications).
export const notifyDataChanged = () => window.dispatchEvent(new Event('app:refresh'));
