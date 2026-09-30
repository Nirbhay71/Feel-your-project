// Intentionally empty.
//
// - "@feel-dev/next/client" outside development: Next builds the browser
//   bundle for production with the "production" condition, so this file is
//   what instrumentation-client.js imports then — Feel never ships to users.
// - "@feel-dev/next/axios" in apps without axios: withFeel points it at
//   axios-patch.js only when the app has axios installed.
