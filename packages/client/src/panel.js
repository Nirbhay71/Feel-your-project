// Piece 4 — the viewer panel (a drawer on the right side of the page).
//
//   ┌─────────────────────────────────────────────┐
//   │ SalesChart   src/…/SalesChart.jsx:14  [↗] [×]│  header
//   │ Dashboard › SalesChart                       │  chain (click to switch)
//   │  12  export default function SalesChart() {  │
//   │  13    return (                              │  code, component lines tinted,
//   │▶ 14      <div className="card chart">        │  clicked line highlighted
//   └─────────────────────────────────────────────┘
//
// Code comes from the agent (GET /__feel/source) and is highlighted with Shiki.

const SOURCE_URL = '/__feel/source';

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
    nav span { color: #6a737d; align-self: center; }

    .code { flex: 1; overflow: auto; }
    .status { padding: 16px; color: #959da5; }
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
    <div class="code"></div>
  </div>
`;
document.documentElement.appendChild(host);

const panel = shadow.querySelector('.panel');
const titleName = shadow.querySelector('.title b');
const titleFile = shadow.querySelector('.title code');
const nav = shadow.querySelector('nav');
const codeBox = shadow.querySelector('.code');

let current = null; // { chain, index, onFocus }
const cache = new Map(); // "file:line" → agent response

// Show the panel for a component chain. The last entry (the clicked
// component) is shown first. onFocus(entry) is called when the user switches
// to another entry, so the page can move the red outline to it.
export function showPanel(chain, onFocus) {
  current = { chain, onFocus };
  panel.classList.add('open');
  show(chain.length - 1);
}

export function hidePanel() {
  current = null;
  panel.classList.remove('open');
}

// Lets the page ignore clicks that land inside the panel.
export function isInPanel(event) {
  return event.composedPath().includes(host);
}

async function show(index) {
  const entry = current.chain[index];
  current.index = index;
  current.onFocus?.(entry);
  renderNav();

  titleName.textContent = entry.component;
  titleFile.textContent = `${entry.file}:${entry.line}`;
  codeBox.innerHTML = '<div class="status">Loading…</div>';

  try {
    const source = await fetchSource(entry);
    if (current?.chain[current.index] !== entry) return; // user clicked away meanwhile
    codeBox.innerHTML = await highlight(source);
    scrollToHighlight();
  } catch (err) {
    codeBox.innerHTML = '<div class="status"></div>';
    codeBox.firstChild.textContent = `Couldn't load source: ${err.message}`;
  }
}

function renderNav() {
  nav.replaceChildren();
  current.chain.forEach((entry, i) => {
    if (i > 0) nav.append(Object.assign(document.createElement('span'), { textContent: '›' }));
    const btn = document.createElement('button');
    btn.textContent = entry.component;
    btn.title = `${entry.file}:${entry.line}`;
    btn.className = i === current.index ? 'active' : '';
    btn.onclick = () => show(i);
    nav.append(btn);
  });
}

async function fetchSource({ file, line }) {
  const key = `${file}:${line}`;
  if (!cache.has(key)) {
    const res = await fetch(`${SOURCE_URL}?file=${encodeURIComponent(file)}&line=${line}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    cache.set(key, body);
  }
  return cache.get(key);
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
async function openInEditor() {
  const entry = current?.chain[current.index];
  if (!entry) return;
  const { absPath } = await fetchSource(entry);
  fetch(`/__open-in-editor?file=${encodeURIComponent(`${absPath}:${entry.line}:${entry.column}`)}`);
}

shadow.querySelector('.open-editor').onclick = openInEditor;
shadow.querySelector('.close').onclick = () => window.dispatchEvent(new CustomEvent('feel:close'));
