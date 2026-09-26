export default function StatCard({ label, value }) {
  return (
    <div className="card stat">
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value ?? '…'}</strong>
    </div>
  );
}
