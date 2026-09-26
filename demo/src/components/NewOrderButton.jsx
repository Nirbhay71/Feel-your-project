import { useMutation, useQueryClient } from '@tanstack/react-query';
import { mutate } from 'swr';
import { placeOrder, notifyDataChanged } from '../api.js';

export default function NewOrderButton() {
  const queryClient = useQueryClient();
  const order = useMutation({
    mutationFn: placeOrder,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sales'] }); // React Query data
      mutate('/api/notifications'); // SWR data
      mutate('/api/products/top');
      notifyDataChanged(); // useApi data
    },
  });

  return (
    <button className="primary" onClick={() => order.mutate()} disabled={order.isPending}>
      {order.isPending ? 'Placing…' : '+ New order'}
    </button>
  );
}
