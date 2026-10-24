const OPERATIONS = {
  GET: 'select',
  POST: 'insert',
  PATCH: 'update',
  DELETE: 'delete',
};

// PostgREST exposes tables at https://<project>.supabase.co/rest/v1/<table>.
export function parseSupabaseRequest(url, method) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!/^[^.]+\.supabase\.co$/i.test(parsed.hostname)) return null;
  const match = parsed.pathname.match(/^\/rest\/v1\/([^/]+)$/);
  const operation = OPERATIONS[String(method).toUpperCase()];
  if (!match || !operation) return null;

  const params = [...parsed.searchParams.entries()];
  const columns = parsed.searchParams.get('select')?.split(',').filter(Boolean) ?? [];
  const modifiers = new Set(['select', 'order', 'limit', 'offset', 'on_conflict']);
  const filters = params.filter(([name]) => !modifiers.has(name)).map(([name, value]) => ({ name, value }));

  return {
    table: decodeURIComponent(match[1]),
    columns,
    filters,
    operation,
  };
}
