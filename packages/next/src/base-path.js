// Tells @feel-dev/client where the agent is when the app has a basePath
// (/docs → /docs/__feel). withFeel puts the basePath in the config's `env`,
// and Next writes the value into the bundle in place of
// process.env.FEEL_BASE_PATH. Imported by client.js before @feel-dev/client.

let base = '';
try {
  base = process.env.FEEL_BASE_PATH || '';
} catch {
  // no `process` in this browser bundle: no basePath
}
globalThis.__FEEL_BASE__ = base;
