import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

export function App() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    fetch('/api/users').then(() => setLoaded(true));
  }, []);
  return <main>
    <h1>Users</h1>
    <p>{loaded ? 'Ready' : 'Loading'}</p>
    <Details />
    <button onClick={() => fetch('https://project.supabase.co/rest/v1/users?select=id')}>Read Supabase</button>
  </main>;
}

function Details() {
  return <h2>Details</h2>;
}

createRoot(document.getElementById('root')).render(<App />);
