import useSWR from 'swr';
import { fetcher } from '../lib/fetcher.js';

export default function TopProducts() {
  const { data = [] } = useSWR('/api/products/top', fetcher);

  return (
    <div className="card top-products">
      <h2>Top products</h2>
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Orders</th>
            <th>Revenue</th>
          </tr>
        </thead>
        <tbody>
          {data.map((p) => (
            <tr key={p.name}>
              <td>{p.name}</td>
              <td>{p.orders}</td>
              <td>${p.revenue.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
