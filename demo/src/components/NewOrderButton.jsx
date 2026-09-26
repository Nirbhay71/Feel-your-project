import { useMutation, useQueryClient } from '@tanstack/react-query';
import { placeOrder, notifyDataChanged } from '../api.js';

export default function NewOrderButton() {
  const queryClient = useQueryClient();
  const order = useMutation({
    mutationFn: placeOrder,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sales'] }); // React Query data
      notifyDataChanged(); // everything else
    },
  });

  return (
    <button className="primary" onClick={() => order.mutate()} disabled={order.isPending}>
      {order.isPending ? 'Placing…' : '+ New order'}
    </button>
  );
}
