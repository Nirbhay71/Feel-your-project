// Backend patches (pg, Drizzle, …) before any route handler runs.
export async function register() {
  if (process.env.NODE_ENV === 'development' && process.env.NEXT_RUNTIME === 'nodejs') {
    await import('@feel-dev/next/register');
  }
}
