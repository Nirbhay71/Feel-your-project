const items = [
  { id: 1, text: 'New order #312 placed' },
  { id: 2, text: 'User jane@example.com signed up' },
  { id: 3, text: 'Payment of $120 received' },
];

export default function Notifications() {
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
