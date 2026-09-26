import StatCard from './StatCard.jsx';
import SalesChart from './SalesChart.jsx';
import Notifications from './Notifications.jsx';
import NewOrderButton from './NewOrderButton.jsx';
import useApi from '../hooks/useApi.js';
import { fetchStats } from '../api.js';

export default function Dashboard() {
  const stats = useApi(fetchStats);

  return (
    <main className="dashboard">
      <header className="top">
        <h1>Dashboard</h1>
        <NewOrderButton />
      </header>
      <section className="stats">
        <StatCard label="Users" value={stats?.users.toLocaleString()} />
        <StatCard label="Orders" value={stats?.orders.toLocaleString()} />
        <StatCard label="Revenue" value={stats && `$${stats.revenue.toLocaleString()}`} />
      </section>
      <section className="row">
        <SalesChart />
        <Notifications />
      </section>
    </main>
  );
}
