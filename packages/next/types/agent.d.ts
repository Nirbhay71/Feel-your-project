// Types for @feel-dev/next/agent — re-exported by app/%5F%5Ffeel/[...path]/route.js.
type RouteContext = { params: Promise<{ path?: string[] }> };
type Handler = (request: Request, context: RouteContext) => Promise<Response>;

export const GET: Handler;
export const POST: Handler;
export function createFeelRoute(options?: Record<string, unknown>): { GET: Handler; POST: Handler };
export function hostAllowed(host: string, allowed?: string[]): boolean;
