'use client';

import ItemList from './ItemList.jsx';

export default function Dashboard() {
  return (
    <section className="dashboard">
      <h1>Items</h1>
      <ItemList />
    </section>
  );
}
