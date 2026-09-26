// Piece 2 — runs in the browser (injected by the Vite plugin in dev).
//
// Hold Alt  → hovering outlines the element under the mouse.
// Alt + right-click → select it:
//   1. find the nearest element with data-src
//   2. walk up the parents to build the component chain (Dashboard → StatCard)
//   3. keep it highlighted and open the viewer panel (Piece 4, panel.js)
//   4. fire a "feel:select" event for anything else that wants to listen
// Esc, the panel's ✕, or a normal click on the page clears the selection.

// First: start recording API calls before the app makes any.
import { getRequests } from './network.js';
import { showPanel, hidePanel, isInPanel } from './panel.js';

const ATTR = 'data-src';

// Outlines live in a shadow root so the app's CSS can't touch them
// and our CSS can't leak into the app.
const host = document.createElement('feel-overlay');
const shadow = host.attachShadow({ mode: 'open' });
shadow.innerHTML = `
  <style>
    .box {
      position: fixed; pointer-events: none; z-index: 2147483646;
      border: 2px solid #4f6bed; background: rgb(79 107 237 / 0.08);
      border-radius: 4px; display: none;
    }
    .box.selected { border-color: #e5484d; background: rgb(229 72 77 / 0.08); }
    .label {
      position: absolute; top: -22px; left: -2px; white-space: nowrap;
      font: 12px/20px ui-monospace, monospace; color: #fff;
      padding: 0 6px; border-radius: 4px 4px 0 0; background: #4f6bed;
    }
    .box.selected .label { background: #e5484d; }
  </style>
  <div class="box hover"><span class="label"></span></div>
  <div class="box selected"><span class="label"></span></div>
`;
document.documentElement.appendChild(host);

const hoverBox = shadow.querySelector('.box.hover');
const selectedBox = shadow.querySelector('.box.selected');

let selectedEl = null;

// "src/components/StatCard.jsx:3:5|StatCard" → { file, line, column, component }
function parseSrc(value) {
  const [loc, component] = value.split('|');
  const [, file, line, column] = loc.match(/^(.*):(\d+):(\d+)$/);
  return { file, line: Number(line), column: Number(column), component };
}

// Walk from the clicked element up to <html>, collecting one entry per component.
// Consecutive elements from the same component collapse into one entry — we keep
// the innermost one, since it's closest to what was clicked.
// Returned outermost first: [Dashboard, StatCard].
function buildChain(el) {
  const chain = [];
  for (let cur = el; cur; cur = cur.parentElement?.closest(`[${ATTR}]`)) {
    const info = parseSrc(cur.getAttribute(ATTR));
    const prev = chain[chain.length - 1];
    if (prev && prev.component === info.component && prev.file === info.file) continue;
    chain.push({ ...info, element: cur });
  }
  return chain.reverse();
}

function placeBox(box, el) {
  if (!el) {
    box.style.display = 'none';
    return;
  }
  const r = el.getBoundingClientRect();
  Object.assign(box.style, {
    display: 'block',
    top: `${r.top}px`,
    left: `${r.left}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
  box.querySelector('.label').textContent = parseSrc(el.getAttribute(ATTR)).component;
}

// Move the red outline to an element (also used when the panel switches
// between entries in the chain).
function focus(el) {
  selectedEl = el;
  placeBox(selectedBox, el);
}

function select(el) {
  focus(el);
  placeBox(hoverBox, null);

  const chain = buildChain(el);
  showPanel(chain, (entry) => focus(entry.element));

  // Handy for poking around in DevTools.
  window.__feel = { element: el, chain, requests: getRequests() };
  window.dispatchEvent(new CustomEvent('feel:select', { detail: { element: el, chain } }));
}

function clear() {
  selectedEl = null;
  placeBox(selectedBox, null);
  placeBox(hoverBox, null);
  hidePanel();
}

// --- Event listeners ------------------------------------------------------
// All use capture: true so we see events before the app can stop them.

// Alt + hover → preview outline.
window.addEventListener(
  'mousemove',
  (e) => {
    const el = e.altKey && !isInPanel(e) ? e.target.closest?.(`[${ATTR}]`) : null;
    placeBox(hoverBox, el && el !== selectedEl ? el : null);
  },
  true,
);

// Releasing Alt hides the hover outline.
window.addEventListener('keyup', (e) => {
  if (e.key === 'Alt') placeBox(hoverBox, null);
});

// Alt + right-click → select. A plain right-click keeps the normal browser menu.
window.addEventListener(
  'contextmenu',
  (e) => {
    if (!e.altKey || isInPanel(e)) return;
    const el = e.target.closest?.(`[${ATTR}]`);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    select(el);
  },
  true,
);

// Esc, the panel's ✕, or a normal left-click on the page clears the selection.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') clear();
});
window.addEventListener('feel:close', clear);
window.addEventListener(
  'mousedown',
  (e) => {
    if (e.button === 0 && !e.altKey && selectedEl && !isInPanel(e)) clear();
  },
  true,
);

// Keep the red outline glued to the element when the page scrolls or resizes.
const follow = () => selectedEl && placeBox(selectedBox, selectedEl);
window.addEventListener('scroll', follow, true);
window.addEventListener('resize', follow);
