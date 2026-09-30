// The agent itself, set up for Next.js: stack frames are located through
// Next's sourcemaps (locator.js) and "Open in editor" goes through Next's own
// /__nextjs_launch-editor endpoint. Loaded lazily by agent.js.

import { createAgentHandler } from '@feel-dev/agent';
import { createNextLocator } from './locator.js';

export function createHandler({ root, projectRoot, database }) {
  return createAgentHandler({
    root,
    projectRoot,
    database,
    locateFrame: createNextLocator({ root }),
    editorUrl: (abs, line) => `/__nextjs_launch-editor?file=${encodeURIComponent(abs)}&line1=${line}&column1=1`,
  });
}
