import { useEffect, useState } from 'react';

// Calls `fetcher` once on mount and returns its result (null while loading).
export default function useApi(fetcher) {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetcher().then(setData).catch(console.error);
  }, [fetcher]);

  return data;
}
