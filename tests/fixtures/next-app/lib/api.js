// Browser-side API helpers.

export async function loadItems() {
  const res = await fetch('/api/items');
  const body = await res.json();
  // Without a database the route answers 500 with fallback rows, so the page still renders.
  return body.items;
}

export function renameItem(id) {
  return fetch('/api/items/' + id, { method: 'POST' });
}
