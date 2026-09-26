// Piece 2 — runs in the browser (injected by the Vite plugin in dev).
//
// Hold Alt  → hovering outlines the element under the mouse.
// Alt + right-click → select it:
//   1. find the nearest element with data-src
//   2. walk up the parents to build the component chain (Dashboard → StatCard)
//   3. keep it highlighted and show the chain in a small card
//   4. fire a "feel:select" event so Piece 4 (the panel) can take over
// Esc or a normal click clears the selection.

const ATTR = 'data-src';

// Everything we draw lives in a shadow root so the app's CSS can't touch it
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
      background: inherit; padding: 0 6px; border-radius: 4px 4px 0 0;
    }
    .box .label { background: #4f6bed; }
    .box.selected .label { background: #e5484d; }
    .card {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      max-width: min(420px, calc(100vw - 32px));
      font: 13px/1.5 system-ui, sans-serif; color: #1f2330;
      background: #fff; border-radius: 10px; padding: 12px 14px;
      box-shadow: 0 8px 30px rgb(0 0 0 / 0.18); display: none;
    }
    .card h3 { margin: 0 0 8px; font-size: 13px; color: #6b7080; font-weight: 500; }
    .card ol { margin: 0; padding-left: 18px; }
    .card li { margin: 2px 0; }
    .card code { font-family: ui-monospace, monospace; font-size: 12px; color: #6b7080; }
    .card li:last-child b { color: #e5484d; }
  </style>
  <div class="box hover"><span class="label"></span></div>
  <div class="box selected"><span class="label"></span></div>
  <div class="card"><h3>Component chain</h3><ol></ol></div>
`;
document.documentElement.appendChild(host);

const hoverBox = shadow.querySelector('.box.hover');
const selectedBox = shadow.querySelector('.box.selected');
const card = shadow.querySelector('.card');

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

function showCard(chain) {
  const list = card.querySelector('ol');
  list.replaceChildren(
    ...chain.map(({ component, file, line }) => {
      const li = document.createElement('li');
      li.innerHTML = `<b></b> <code></code>`;
      li.querySelector('b').textContent = component;
      li.querySelector('code').textContent = `${file}:${line}`;
      return li;
    }),
  );
  card.style.display = 'block';
}

function select(el) {
  selectedEl = el;
  placeBox(selectedBox, el);
  hoverBox.style.display = 'none';

  const chain = buildChain(el);
  showCard(chain);

  // Handy for poking around in DevTools.
  window.__feel = { element: el, chain };
  console.log('[feel] selected', chain.map(({ element, ...rest }) => rest));

  // Piece 4 (the panel) will listen for this.
  window.dispatchEvent(new CustomEvent('feel:select', { detail: { element: el, chain } }));
}

function clear() {
  selectedEl = null;
  placeBox(selectedBox, null);
  placeBox(hoverBox, null);
  card.style.display = 'none';
}

// --- Event listeners ------------------------------------------------------
// All use capture: true so we see events before the app can stop them.

// Alt + hover → preview outline.
window.addEventListener(
  'mousemove',
  (e) => {
    const el = e.altKey ? e.target.closest?.(`[${ATTR}]`) : null;
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
    if (!e.altKey) return;
    const el = e.target.closest?.(`[${ATTR}]`);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    select(el);
  },
  true,
);

// Esc or a normal left-click clears the selection.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') clear();
});
window.addEventListener(
  'mousedown',
  (e) => {
    if (e.button === 0 && !e.altKey && selectedEl) clear();
  },
  true,
);

// Keep the red outline glued to the element when the page scrolls or resizes.
const follow = () => selectedEl && placeBox(selectedBox, selectedEl);
window.addEventListener('scroll', follow, true);
window.addEventListener('resize', follow);
