// What the loader's rewritten route files import at runtime (see wrap-route.js).
// Re-exported through @feel-dev/next so the route file only needs a package
// the app depends on directly. withFeel lists @feel-dev/next and
// @feel-dev/node as serverExternalPackages, so Node loads them once — the
// request context here is the same one the pg / mysql2 patches read.

export { wrapRouteHandler, wrapPagesHandler } from '@feel-dev/node/next';
