// Piece 4 — the viewer panel (a drawer on the right side of the page).
//
//   ┌──────────────────────────────────────────────────┐
//   │ SalesChart   src/…/SalesChart.jsx:9    [↗] [✕]   │  header
//   │ Dashboard › SalesChart                            │  component chain
//   │ DATA FLOW                                         │  Layer 2: API calls made
//   │  GET /api/sales  200 · 8 ms                       │  by this component
//   │   Frontend  useApi → fetchSales → getJson         │  (each step clickable)
//   │   Backend   GET /api/sales → handler              │
//   │  12  export default function SalesChart() {       │  code: function tinted,
//   │▶ 14      <div className="card chart">             │  target line highlighted
//   └──────────────────────────────────────────────────┘
//
// Code comes from the agent (GET /__feel/source) and is highlighted with Shiki.

import { getRequests, onRequestsChange } from './network.js';

const AGENT = '/__feel';

const host = document.createElement('feel-panel');
const shadow = host.attachShadow({ mode: 'open' });
shadow.innerHTML = `
  <style>
    :host { all: initial; }
    .panel {
      position: fixed; top: 0; right: 0; bottom: 0; z-index: 2147483647;
      width: min(640px, 100vw); display: none; flex-direction: column;
      background: #24292e; color: #e1e4e8;
      font: 13px/1.5 system-ui, sans-serif;
      box-shadow: -8px 0 30px rgb(0 0 0 / 0.25);
    }
    .panel.open { display: flex; }

    header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #3a4048; }
    .title { flex: 1; min-width: 0; }
    .title b { font-size: 15px; color: #fff; }
    .title code { display: block; color: #959da5; font: 12px ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button {
      font: inherit; color: #e1e4e8; background: #3a4048; border: 0; border-radius: 6px;
      padding: 6px 10px; cursor: pointer;
    }
    button:hover { background: #4a5058; }

    nav { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 16px; border-bottom: 1px solid #3a4048; }
    nav button { padding: 2px 8px; background: transparent; color: #959da5; }
    nav button.active { background: #e5484d; color: #fff; }
    .sep { color: #6a737d; align-self: center; }

    .flow { max-height: 40%; overflow: auto; padding: 8px 16px 10px; border-bottom: 1px solid #3a4048; }
    .flow h4 { margin: 0 0 6px; font-size: 11px; letter-spacing: 0.06em; color: #959da5; font-weight: 600; }
    .flow .empty { color: #6a737d; }
    .req { padding: 6px 0; }
    .req + .req { border-top: 1px dashed #3a4048; }
    .req-head { font: 12.5px ui-monospace, monospace; }
    .req-head .method { color: #79b8ff; font-weight: 700; }
    .req-head .status { margin-left: 6px; }
    .req-head .ok { color: #85e89d; }
    .req-head .bad { color: #f97583; }
    .req-head .muted, .hop .muted { color: #6a737d; }
    .hop { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 4px; padding-left: 8px; }
    .hop .tag { width: 64px; font-size: 11px; color: #959da5; }
    .hop button { padding: 1px 7px; font: 12px ui-monospace, monospace; background: #2f363d; }
    .hop button:hover { background: #444d56; }
    .hop button.fe { color: #b392f0; }
    .hop button.be { color: #ffab70; }

    .code { flex: 1; overflow: auto; }
    .status-msg { padding: 16px; color: #959da5; }
    pre { margin: 0; padding: 8px 0; font: 12.5px/1.6 ui-monospace, Consolas, monospace; background: transparent !important; }
    .line { display: inline-block; min-width: 100%; padding-right: 16px; }
    .line::before {
      content: attr(data-line); display: inline-block; width: 3.5em; margin-right: 16px;
      padding-right: 8px; text-align: right; color: #6a737d;
    }
    .line.in { background: rgb(255 255 255 / 0.04); }
    .line.hl { background: rgb(229 72 77 / 0.25); box-shadow: inset 3px 0 #e5484d; }
  </style>
  <div class="panel">
    <header>
      <div class="title"><b></b><code></code></div>
      <button class="open-editor" title="Open this line in your editor">Open in editor ↗</button>
      <button class="close" title="Close (Esc)">✕</button>
    </header>
    <nav></nav>
    <div class="flow"></div>
    <div class="code"></div>
  </div>
`;
document.documentElement.appendChild(host);

const panel = shadow.querySelector('.panel');
const titleName = shadow.querySelector('.title b');
const titleFile = shadow.querySelector('.title code');
const nav = shadow.querySelector('nav');
const flowBox = shadow.querySelector('.flow');
const codeBox = shadow.querySelector('.code');

// chain:  component chain from the page
// index:  which chain entry the data-flow section is showing
// shown:  what the code viewer is showing (agent response), for "Open in editor"
let current = null;
const sourceCache = new Map(); // query string → agent response
const reachCache = new Map(); // "file#component" → Set of "file#fn"

// Show the panel for a component chain, starting at the clicked component.
// onFocus(entry) moves the red outline on the page.
export function showPanel(chain, onFocus) {
  current = { chain, onFocus, index: 0, shown: null };
  panel.classList.add('open');
  selectEntry(chain.length - 1);
}

export function hidePanel() {
  current = null;
  panel.classList.remove('open');
}

// Lets the page ignore clicks that land inside the panel.
export function isInPanel(event) {
  return event.composedPath().includes(host);
}

// New API calls may arrive while the panel is open — refresh the list.
onRequestsChange(() => current && renderFlow());

// --- Chain ----------------------------------------------------------------

function selectEntry(index) {
  const entry = current.chain[index];
  current.index = index;
  current.onFocus?.(entry);
  renderNav();
  renderFlow();
  showCode({ file: entry.file, line: entry.line });
}

function renderNav() {
  nav.replaceChildren();
  current.chain.forEach((entry, i) => {
    if (i > 0) nav.append(el('span', { className: 'sep', textContent: '›' }));
    nav.append(
      el('button', {
        textContent: entry.component,
        title: `${entry.file}:${entry.line}`,
        className: i === current.index ? 'active' : '',
        onclick: () => selectEntry(i),
      }),
    );
  });
}

// --- Data flow (Layer 2) ------------------------------------------------------

async function renderFlow() {
  const entry = current.chain[current.index];
  const reach = await fetchReach(entry);
  if (current?.chain[current.index] !== entry) return; // switched meanwhile

  // Group identical calls (same method + url + call path) and keep the latest.
  const groups = new Map();
  for (const req of getRequests()) {
    if (!belongsTo(req, entry, reach)) continue;
    const key = `${req.method} ${req.url} ${req.frames.map((f) => `${f.file}:${f.line}`).join()}`;
    const prev = groups.get(key);
    groups.set(key, { req, count: (prev?.count ?? 0) + 1 });
  }

  flowBox.replaceChildren(el('h4', { textContent: 'DATA FLOW' }));
  if (!groups.size) {
    flowBox.append(el('div', { className: 'empty', textContent: 'No API calls from this component yet.' }));
    return;
  }
  for (const { req, count } of groups.values()) flowBox.append(renderRequest(req, count));
}

// Does this request belong to the selected component?
//   1. Runtime: the component itself is on the call stack (fetch inside its useEffect), or
//   2. Static:  every function on the stack is reachable from the component
//               (fetch inside a custom hook → the component isn't on the stack).
function belongsTo(req, entry, reach) {
  const own = req.frames?.filter((f) => f.fn) ?? [];
  if (!own.length) return false;
  if (own.some((f) => f.file === entry.file && f.component === entry.component)) return true;
  return own.every((f) => reach.has(`${f.file}#${f.fn}`));
}

function renderRequest(req, count) {
  const ok = req.status >= 200 && req.status < 400;
  const head = el(
    'div',
    { className: 'req-head' },
    el('span', { className: 'method', textContent: req.method }),
    ` ${req.url}`,
    el('span', { className: `status ${ok ? 'ok' : 'bad'}`, textContent: req.status || 'failed' }),
    el('span', { className: 'muted', textContent: ` · ${Math.round(req.duration)} ms${count > 1 ? ` · ×${count}` : ''}` }),
  );

  // Frontend: the stack, outermost first — e.g. useApi → fetchSales → getJson.
  const frontend = el('div', { className: 'hop' }, el('span', { className: 'tag', textContent: 'Frontend' }));
  [...req.frames].reverse().forEach((f, i) => {
    if (i > 0) frontend.append(el('span', { className: 'muted', textContent: '→' }));
    frontend.append(
      el('button', {
        className: 'fe',
        textContent: f.fn ?? '(anonymous)',
        title: `${f.file}:${f.line}`,
        onclick: () => showCode({ file: f.file, line: f.line }),
      }),
    );
  });

  // Backend: the route and its handler(s), from the X-Feel-Route header.
  const backend = el('div', { className: 'hop' }, el('span', { className: 'tag', textContent: 'Backend' }));
  if (req.backend) {
    backend.append(el('span', { textContent: `${req.backend.method} ${req.backend.path}` }));
    for (const h of req.backend.handlers) {
      backend.append(
        el('span', { className: 'muted', textContent: '→' }),
        el('button', {
          className: 'be',
          textContent: h.name ?? 'inline handler',
          title: `registered at ${h.file}:${h.line}`,
          onclick: () => showCode({ file: h.file, line: h.line, resolve: 'handler', index: h.index }),
        }),
      );
    }
  } else {
    backend.append(el('span', { className: 'muted', textContent: 'not instrumented (add @feel/express)' }));
  }

  return el('div', { className: 'req' }, head, frontend, backend);
}

async function fetchReach({ file, component }) {
  const key = `${file}#${component}`;
  if (!reachCache.has(key)) {
    const q = new URLSearchParams({ file, component });
    const res = await fetch(`${AGENT}/reach?${q}`);
    reachCache.set(key, new Set(res.ok ? (await res.json()).functions : []));
  }
  return reachCache.get(key);
}

// --- Code viewer ------------------------------------------------------------

// params: { file, line, resolve?, index? } — see the agent's /source route.
async function showCode(params) {
  titleName.textContent = '…';
  titleFile.textContent = `${params.file}:${params.line}`;
  codeBox.innerHTML = '<div class="status-msg">Loading…</div>';
  const token = (showCode.token = {});

  try {
    const source = await fetchSource(params);
    if (showCode.token !== token || !current) return; // user clicked something else meanwhile
    current.shown = source;
    titleName.textContent = source.name ?? source.file.split('/').pop();
    titleFile.textContent = `${source.file}:${source.highlightLine}`;
    codeBox.innerHTML = await highlight(source);
    scrollToHighlight();
  } catch (err) {
    codeBox.replaceChildren(el('div', { className: 'status-msg', textContent: `Couldn't load source: ${err.message}` }));
  }
}

async function fetchSource(params) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
  if (!sourceCache.has(q)) {
    const res = await fetch(`${AGENT}/source?${q}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    sourceCache.set(q, body);
  }
  return sourceCache.get(q);
}

// Shiki is loaded only the first time the panel opens, so it doesn't slow
// down the app's page load.
async function highlight({ code, language, startLine, endLine, highlightLine }) {
  const { codeToHtml } = await import('shiki');
  return codeToHtml(code, {
    lang: language ?? 'javascript',
    theme: 'github-dark',
    transformers: [
      {
        // Called once per line: add the line number and our highlight classes.
        line(node, n) {
          node.properties['data-line'] = n;
          if (n === highlightLine) this.addClassToHast(node, 'hl');
          else if (n >= startLine && n <= endLine) this.addClassToHast(node, 'in');
        },
      },
    ],
  });
}

function scrollToHighlight() {
  const line = codeBox.querySelector('.line.hl');
  if (line) codeBox.scrollTop = line.offsetTop - codeBox.clientHeight / 3;
}

// Vite's dev server has a built-in /__open-in-editor endpoint that opens a
// file:line in whichever editor is running (VS Code, WebStorm, …).
function openInEditor() {
  const shown = current?.shown;
  if (!shown) return;
  fetch(`/__open-in-editor?file=${encodeURIComponent(`${shown.absPath}:${shown.highlightLine}`)}`);
}

shadow.querySelector('.open-editor').onclick = openInEditor;
shadow.querySelector('.close').onclick = () => window.dispatchEvent(new CustomEvent('feel:close'));

// Tiny DOM helper: el('button', { textContent: 'Hi', onclick }, ...children)
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
