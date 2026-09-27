import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useQuery } from '@tanstack/react-query';
import { fetchSales } from '@/api.js';

export default function SalesChart() {
  // React Query calls fetchSales from its own scheduler, not from here.
  const { data = [] } = useQuery({ queryKey: ['sales'], queryFn: fetchSales });

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
