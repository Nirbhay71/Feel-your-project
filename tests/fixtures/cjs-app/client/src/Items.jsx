import { useEffect, useState } from 'react';
import { itemsApi } from './api';

export default function Items() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    itemsApi.list().then((res) => setItems(res.data));
  }, []);

  function open(id) {
    return itemsApi.get(id);
  }

  return <ul>{items.map((i) => <li key={i.id} onClick={() => open(i.id)}>{i.name}</li>)}</ul>;
}
