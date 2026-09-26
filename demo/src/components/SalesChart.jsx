import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

// Hardcoded for now; Layer 2 will replace this with a fetch to the backend.
const data = [
  { day: 'Mon', sales: 120 },
  { day: 'Tue', sales: 180 },
  { day: 'Wed', sales: 150 },
  { day: 'Thu', sales: 220 },
  { day: 'Fri', sales: 260 },
];

export default function SalesChart() {
  return (
    <div className="card chart">
      <h2>Sales this week</h2>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data}>
          <XAxis dataKey="day" />
          <YAxis />
          <Tooltip />
          <Line type="monotone" dataKey="sales" stroke="#4f6bed" strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
