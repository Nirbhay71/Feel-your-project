// The component chain from React's own tree (the "fiber fix").
//
// The DOM-only chain (index.js buildChain) has two gaps:
//   - a parent entry points at *some* HTML tag in the parent, not at the line
//     where the child component is used (<Notifications />)
//   - components that render no HTML of their own are invisible
//
// React keeps a "fiber" object for every element, reachable from its DOM node.
// Walking fiber.return goes up the real component tree. For each fiber:
//   - fiber.type.__feelSrc (added by our Vite plugin) says it's one of *your*
//     components and where it's defined — library components don't have it
//   - fiber._debugStack (React 19, dev only) is a stack trace captured when
//     the JSX element was created — its first frame in your code is the exact
//     line of <Notifications /> inside Dashboard. The agent maps it through
//     sourcemaps like any other stack.

import { resolveStack } from './network.js';

const ATTR = 'data-src';

// Returns [{ component, file, line, column, element }] outermost first,
// or null if this page has no React fibers (then the DOM chain is used).
export async function buildFiberChain(el) {
  const fiber = fiberOf(el);
  if (!fiber) return null;

  // 1. Your components from the clicked element up to the root (innermost first).
  const comps = [];
  for (let f = fiber; f; f = f.return) {
    const info = componentInfo(f);
    if (!info) continue;
    const prev = comps[comps.length - 1];
    if (prev && prev.component === info.component && prev.file === info.file) continue; // memo + inner fiber
    comps.push({ ...info, fiber: f });
  }
  if (!comps.length) return null;
  comps.reverse(); // outermost first

  // 2. Where each component was used: first frame of its _debugStack.
  await Promise.all(
    comps.map(async (c) => {
      const stack = c.fiber._debugStack?.stack;
      if (stack) c.usage = (await resolveStack(stack))[0] ?? null;
    }),
  );

  // 3. Each entry's line: in the parent, the line that renders the next
  //    component down. If the child was created somewhere else (passed in
  //    as children from further up), fall back to a tagged HTML line inside
  //    the component, then to the line where it's defined.
  const clicked = parseSrc(el.getAttribute(ATTR));
  const chain = comps.map((c, i) => {
    const child = comps[i + 1];
    const line =
      child?.usage?.file === c.file ? { line: child.usage.line, column: child.usage.column } : domLine(el, c) ?? { line: c.defLine, column: 1 };
    return { component: c.component, file: c.file, ...line, element: firstElement(c.fiber) ?? el };
  });

  // The innermost entry points at exactly what was clicked.
  const last = chain[chain.length - 1];
  if (clicked && clicked.component === last.component && clicked.file === last.file) {
    Object.assign(last, { line: clicked.line, column: clicked.column, element: el });
  }
  return chain;
}

// React stores the fiber on the DOM node under a random key: __reactFiber$abc123.
function fiberOf(el) {
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
  return key ? el[key] : null;
}

// "src/components/Notifications.jsx:3|Notifications" → { component, file, defLine }
function componentInfo(fiber) {
  const src = fiber.type?.__feelSrc ?? fiber.elementType?.__feelSrc;
  if (typeof src !== 'string') return null;
  const [loc, component] = src.split('|');
  const [, file, line] = loc.match(/^(.*):(\d+)$/);
  return { component, file, defLine: Number(line) };
}

// First real DOM element a component rendered — used for the page outline.
function firstElement(fiber) {
  const stack = [fiber.child];
  while (stack.length) {
    const f = stack.shift();
    if (!f) continue;
    if (f.stateNode instanceof Element) return f.stateNode;
    stack.push(f.child, f.sibling);
  }
  return null;
}

// A tagged HTML line inside component c, on the way up from the clicked element.
function domLine(el, c) {
  for (let cur = el; cur; cur = cur.parentElement?.closest(`[${ATTR}]`)) {
    const info = parseSrc(cur.getAttribute(ATTR));
    if (info?.component === c.component && info.file === c.file) return { line: info.line, column: info.column };
  }
  return null;
}

function parseSrc(value) {
  if (!value) return null;
  const [loc, component] = value.split('|');
  const m = loc.match(/^(.*):(\d+):(\d+)$/);
  return m && { file: m[1], line: Number(m[2]), column: Number(m[3]), component };
}
