// The agent's HTTP side under Next.js. The browser script always talks to
// /__feel/…, so the app gets one catch-all route file that re-exports these:
//
//   app/%5F%5Ffeel/[...path]/route.js
//     export { GET, POST } from '@feel-dev/next/agent';
//
// (%5F%5F is "__" escaped: Next treats folders starting with _ as private and
// never routes them.)
//
// Three gates before anything runs:
//   1. development only — `next start` still has this route, so it answers
//      404 unless withFeel set up `next dev` (it sets __FEEL_NEXT then)
//   2. the Host must be this machine (or one you allowed): otherwise a page on
//      evil.example could point its own DNS name at 127.0.0.1 and read your
//      source through the browser ("DNS rebinding")
//   3. the agent's own checks: same Origin, X-Feel header on POSTs

const LOOPBACK = /^(?:(?:[a-z0-9-]+\.)*localhost|127\.0\.0\.1|\[::1\])$/i;

// options (all optional — withFeel passes them through process.env.__FEEL_NEXT):
//   dev:          force development mode on/off (tests)
//   root:         Next project root (default: process.cwd())
//   projectRoot:  folder with frontend and backend, if not the nearest .git
//   database:     connection string for the table view
//   allowedHosts: extra host names allowed to reach the agent, like Next's
//                 allowedDevOrigins ("192.168.1.5", "*.my-dev.test")
export function createFeelRoute(options = {}) {
  let handler = null; // created on first use — it loads Babel and friends

  async function serve(request, context) {
    const settings = { ...readEnv(), ...options };
    if (!(settings.dev ?? (process.env.NODE_ENV === 'development' && !!process.env.__FEEL_NEXT))) return json(404, { error: 'Not found' });

    const url = new URL(request.url);
    const host = request.headers.get('host') ?? url.host;
    if (!hostAllowed(host, settings.allowedHosts)) return json(403, { error: `Host ${host} is not allowed — add it to allowedDevOrigins` });

    if (!handler) handler = loadHandler(settings);
    const agent = await handler;
    const segments = (await context?.params)?.path ?? [];
    const result = await agent.handle({
      method: request.method,
      pathname: `/${[].concat(segments).join('/')}`,
      searchParams: url.searchParams,
      headers: Object.fromEntries(request.headers),
      readBody: () => request.text(),
      // Maps are fetched back from this dev server (see locator.js). The Host
      // was checked above, so this can only be this machine.
      origin: `${url.protocol}//${host}`,
    });
    return result ? json(result.status, result.body) : json(404, { error: 'Not found' });
  }

  return { GET: serve, POST: serve };
}

export const { GET, POST } = createFeelRoute();

// The part that needs Babel, pg and the rest. Behind the development check,
// so a production server never even loads it.
async function loadHandler(settings) {
  if (process.env.NODE_ENV !== 'development' && !settings.dev) throw new Error('Feel only runs in development');
  const { createHandler } = await import('./handler.js');
  return createHandler({
    root: settings.root ?? process.cwd(),
    projectRoot: settings.projectRoot,
    database: settings.database ?? process.env.FEEL_DATABASE_URL,
  });
}

function readEnv() {
  try {
    return JSON.parse(process.env.__FEEL_NEXT ?? '{}');
  } catch {
    return {};
  }
}

// "localhost:3000" → allowed; "evil.example:3000" → only if listed.
export function hostAllowed(host, allowed = []) {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  if (LOOPBACK.test(name)) return true;
  return [].concat(allowed ?? []).some((pattern) => {
    const p = String(pattern).toLowerCase().replace(/:\d+$/, '');
    return p.startsWith('*.') ? name.endsWith(p.slice(1)) : name === p;
  });
}

function json(status, body) {
  return Response.json(body, { status });
}
