async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

export const fetchStats = () => getJson('/api/stats');
export const fetchSales = () => getJson('/api/sales');
