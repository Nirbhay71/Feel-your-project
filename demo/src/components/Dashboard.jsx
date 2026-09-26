import StatCard from './StatCard.jsx';
import SalesChart from './SalesChart.jsx';
import Notifications from './Notifications.jsx';

export default function Dashboard() {
  return (
    <main className="dashboard">
      <h1>Dashboard</h1>
      <section className="stats">
        <StatCard label="Users" value="1,204" />
        <StatCard label="Orders" value="312" />
        <StatCard label="Revenue" value="$8,450" />
      </section>
      <section className="row">
        <SalesChart />
        <Notifications />
      </section>
    </main>
  );
}
