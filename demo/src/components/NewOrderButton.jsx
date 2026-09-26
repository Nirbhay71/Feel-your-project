import { useState } from 'react';
import { placeOrder, notifyDataChanged } from '../api.js';

export default function NewOrderButton() {
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    setBusy(true);
    try {
      await placeOrder();
      notifyDataChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="primary" onClick={handleClick} disabled={busy}>
      {busy ? 'Placing…' : '+ New order'}
    </button>
  );
}
