import { useEffect, useState } from 'react';

export default function Notifications() {
  const [items, setItems] = useState([]);

  // Fetches directly in the component (no hook / api layer).
  useEffect(() => {
    fetch('/api/notifications')
      .then((res) => res.json())
      .then(setItems);
  }, []);

  return (
    <div className="card notifications">
      <h2>Notifications</h2>
      <ul>
        {items.map((n) => (
          <li key={n.id}>{n.text}</li>
        ))}
      </ul>
    </div>
  );
}
