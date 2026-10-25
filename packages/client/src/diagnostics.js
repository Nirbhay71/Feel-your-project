// Connection evidence comes from captured responses, not configuration guesses.
export function runtimeChecks(requests) {
  const instrumented = requests.filter((r) => r.backend);
  const queries = instrumented.flatMap((r) => r.backend.queries ?? []);
  const plainApi = requests.some((r) => !r.supabase && !r.backend && r.status >= 200 && r.status < 400 && /\/api\//.test(r.url));
  return [
    { id: 'backend', label: 'Backend instrumentation', status: instrumented.length ? 'ok' : plainApi ? 'warning' : 'unknown', message: instrumented.length ? 'Feel backend metadata was observed on an API response.' : plainApi ? 'An API response arrived without Feel metadata. Check the first register import and proxy/CORS header exposure. Direct Supabase requests do not need Node instrumentation.' : 'No instrumented request observed yet. Interact with an API-backed component, then check again. Supabase table requests do not need Node instrumentation.' },
    { id: 'sql', label: 'Observed SQL', status: queries.length ? 'ok' : 'unknown', message: queries.length ? 'SQL queries were captured from the backend.' : 'No SQL observed yet. This may be normal for the selected requests; it does not prove the database is disconnected.' },
  ];
}
