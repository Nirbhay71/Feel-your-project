// The agent itself, set up for Next.js: stack frames are located through
// Next's sourcemaps (locator.js) and "Open in editor" goes through Next's own
// /__nextjs_launch-editor endpoint. Loaded lazily by agent.js.

import { createAgentHandler } from '@feel-dev/agent';
import { createNextLocator } from './locator.js';

// basePath: Next's basePath ('' when none) — its own endpoints move under it.
export function createHandler({ root, projectRoot, database, basePath = '' }) {
  return createAgentHandler({
    root,
    projectRoot,
    database,
    locateFrame: createNextLocator({ root, basePath }),
    editorUrl: (abs, line) => editorUrl(abs, line, basePath),
  });
}

// Next has named the position parameters two ways over the years
// (line1/column1 now, lineNumber/column before); send both.
export function editorUrl(abs, line, basePath = '') {
  return `${basePath}/__nextjs_launch-editor?file=${encodeURIComponent(abs)}&line1=${line}&column1=1&lineNumber=${line}&column=1`;
}
