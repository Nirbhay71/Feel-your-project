import { useEffect, useState } from 'react';

// Calls `fetcher` on mount (and whenever data changes) and returns its
// result (null while loading).
export default function useApi(fetcher) {
  const [data, setData] = useState(null);

  useEffect(() => {
    const load = () => fetcher().then(setData).catch(console.error);
    load();
    window.addEventListener('app:refresh', load);
    return () => window.removeEventListener('app:refresh', load);
  }, [fetcher]);

  return data;
}
