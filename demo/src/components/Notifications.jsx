import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher.js';

export default function Notifications() {
  // Same shared fetcher as TopProducts — only the key (URL) differs.
  const { data: items = [], mutate } = useSWR('/api/notifications', fetcher);

  async function dismiss(id) {
    await fetch(`/api/notifications/${id}`, { method: 'DELETE' });
    mutate();
  }

  return (
    <div className="card notifications">
      <h2>Notifications</h2>
      <ul>
        {items.map((n) => (
          <li key={n.id}>
            {n.text}
            <button className="dismiss" onClick={() => dismiss(n.id)} title="Dismiss">
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
