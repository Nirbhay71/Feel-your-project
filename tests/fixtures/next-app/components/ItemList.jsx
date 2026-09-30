'use client';

import { useEffect, useState } from 'react';
import { loadItems, renameItem } from '../lib/api.js';

export default function ItemList() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadItems().then(setItems, (err) => setError(err.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!items) return <p>Loading…</p>;
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>
          {item.name}
          <button onClick={() => renameItem(item.id)}>Rename</button>
        </li>
      ))}
    </ul>
  );
}
