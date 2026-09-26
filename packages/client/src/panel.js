// Piece 4 — the viewer panel (a drawer on the right side of the page).
//
//   ┌──────────────────────────────────────────────────┐
//   │ SalesChart   src/…/SalesChart.jsx:9    [↗] [✕]   │  header
//   │ Dashboard › SalesChart                            │  component chain
//   │ DATA FLOW                                         │  Layer 2: API calls made
//   │  GET /api/sales  200 · 8 ms                       │  by this component
//   │   Frontend  useApi → fetchSales → getJson         │  (each step clickable)
//   │   Backend   GET /api/sales → inline handler       │
//   │   Database  sales.js:8  SELECT … [orders]  3 ms   │  Layer 3: SQL + tables
//   │                                                   │  (click a table → structure,
//   │                                                   │   relations, recent changes)
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
    .panel.table-mode .open-editor { display: none; } /* tables can't be opened in an editor */

    nav { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 16px; border-bottom: 1px solid #3a4048; }
    nav button { padding: 2px 8px; background: transparent; color: #959da5; }
    nav button.active { background: #e5484d; color: #fff; }
    .sep { color: #6a737d; align-self: center; }

    .flow { max-height: 45%; overflow: auto; padding: 8px 16px 10px; border-bottom: 1px solid #3a4048; }
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
    .hop .sql {
      max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font: 12px ui-monospace, monospace; color: #959da5;
    }
    .bad { color: #f97583; }
    button.db { padding: 1px 7px; font: 12px ui-monospace, monospace; background: #2f363d; }
    button.db.read { color: #79b8ff; }
    button.db.write { color: #f97583; }

    .table-view { padding: 12px 16px 24px; }
    .table-view h4 { margin: 16px 0 6px; font-size: 11px; letter-spacing: 0.06em; color: #959da5; font-weight: 600; }
    .table-view h4:first-child { margin-top: 0; }
    .cols { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    .cols th { text-align: left; font-weight: 500; color: #6a737d; padding: 4px 8px 4px 0; border-bottom: 1px solid #3a4048; }
    .cols td { padding: 4px 8px 4px 0; border-bottom: 1px solid #2f363d; vertical-align: top; }
    .mono { font-family: ui-monospace, monospace; }
    .muted { color: #6a737d; }
    .pk { font-size: 11px; font-weight: 700; color: #ffdf5d; margin-right: 6px; }
    .relations div { margin: 3px 0; }
    .changes { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
    .change { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
    .change .diff { color: #e1e4e8; font-family: ui-monospace, monospace; font-size: 12px; overflow-wrap: anywhere; }
    .op { font-size: 11px; font-weight: 700; }
    .op.insert { color: #85e89d; }
    .op.update { color: #ffab70; }
    .op.delete { color: #f97583; }
    .audit-off { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }

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
const reachCache = new Map(); // "file#component" → { functions: Set, direct: Set } of "file#fn"

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

// New API calls may arrive while the panel is open — refresh the list, and
// the table view if one is open (its "recent changes" may have grown).
onRequestsChange(() => {
  if (!current) return;
  renderFlow();
  if (current.shown?.table) showTable(current.shown.table);
});

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
// Walk the stack from the fetch outwards (innermost first):
//   - every frame must be code the component can reach (static call graph)…
//   - …until we hit the component's own code (runtime: it's on the stack) → yes
//   - if we run out of reachable frames first, it's still ours when the last
//     one is something the component calls *directly* — e.g. SalesChart calls
//     useApi, and useApi's effect made the request.
// This stops at event boundaries too: a refetch triggered by NewOrderButton's
// click has handleClick further out, but fetchSales isn't reachable from it.
function belongsTo(req, entry, reach) {
  if (!req.frames) return false; // stack not resolved yet
  let last = null;
  for (const f of req.frames) {
    if (f.file === entry.file && f.component === entry.component) return true;
    if (!f.top || !reach.functions.has(`${f.file}#${f.top}`)) break;
    last = f;
  }
  return !!last && reach.direct.has(`${last.file}#${last.top}`);
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
    backend.append(el('span', { className: 'muted', textContent: 'not instrumented (add @feel/node)' }));
  }

  const rows = [head, frontend, backend];
  for (const q of req.backend?.queries ?? []) rows.push(renderQuery(q));
  return el('div', { className: 'req' }, ...rows);
}

// Database: one row per SQL query the backend ran for this request.
//   Database  orders.js:5  INSERT INTO orders … [orders ✎] [users] [products]  4 ms · 1 row
function renderQuery(q) {
  const row = el('div', { className: 'hop' }, el('span', { className: 'tag', textContent: 'Database' }));
  row.append(
    el('button', {
      className: 'be',
      textContent: `${q.file.split(/[\\/]/).pop()}:${q.line}`,
      title: `Query sent from ${q.file}:${q.line}`,
      onclick: () => showCode({ file: q.file, line: q.line }),
    }),
    el('code', { className: 'sql', textContent: q.sql.replace(/\s+/g, ' ').trim(), title: q.sql.trim() }),
  );
  for (const t of q.tables ?? []) {
    row.append(
      el('button', {
        className: `db ${t.access}`,
        textContent: t.access === 'write' ? `${t.name} ✎` : t.name,
        title: `${t.access === 'write' ? 'Writes to' : 'Reads from'} ${t.name}`,
        onclick: () => showTable(t.name),
      }),
    );
  }
  const stats = q.error
    ? `error: ${q.error}`
    : `${q.duration == null ? '?' : Math.round(q.duration)} ms · ${q.rowCount ?? '?'} row${q.rowCount === 1 ? '' : 's'}`;
  row.append(el('span', { className: q.error ? 'bad' : 'muted', textContent: stats }));
  return row;
}

// --- Table view (Layer 3) -------------------------------------------------------

async function showTable(name) {
  titleName.textContent = name;
  titleFile.textContent = 'table · loading…';
  if (current) current.shown = { table: name };
  panel.classList.add('table-mode');
  const token = (showCode.token = {});
  codeBox.innerHTML = '<div class="status-msg">Loading…</div>';

  const res = await fetch(`${AGENT}/db/table?name=${encodeURIComponent(name)}`);
  const table = await res.json();
  if (showCode.token !== token || !current) return;
  if (!res.ok) {
    codeBox.replaceChildren(el('div', { className: 'status-msg', textContent: table.error }));
    return;
  }

  titleFile.textContent = `table · ${table.rowCount} rows · ${table.columns.length} columns`;
  codeBox.replaceChildren(renderTable(table));
}

function renderTable(t) {
  const fkByColumn = new Map(t.references.map((f) => [f.from_column, f]));
  const view = el('div', { className: 'table-view' });

  // Structure
  view.append(el('h4', { textContent: 'STRUCTURE' }));
  const grid = el('table', { className: 'cols' });
  grid.append(el('tr', {}, ...['Column', 'Type', 'Null', 'Key'].map((h) => el('th', { textContent: h }))));
  for (const c of t.columns) {
    const key = el('td');
    if (t.primaryKey.includes(c.name)) key.append(el('span', { className: 'pk', textContent: 'PK' }));
    const fk = fkByColumn.get(c.name);
    if (fk) key.append(tableLink(fk.to_table, `→ ${fk.to_table}.${fk.to_column}`));
    grid.append(
      el(
        'tr',
        {},
        el('td', { className: 'mono', textContent: c.name }),
        el('td', { className: 'muted', textContent: c.type }),
        el('td', { className: 'muted', textContent: c.nullable ? 'yes' : '' }),
        key,
      ),
    );
  }
  view.append(grid);

  // Relations
  view.append(el('h4', { textContent: 'RELATIONS' }));
  const rel = el('div', { className: 'relations' });
  for (const f of t.references) {
    rel.append(el('div', {}, 'references ', tableLink(f.to_table), el('span', { className: 'muted', textContent: ` via ${f.from_column} → ${f.to_column}` })));
  }
  for (const f of t.referencedBy) {
    rel.append(el('div', {}, 'referenced by ', tableLink(f.from_table), el('span', { className: 'muted', textContent: ` via ${f.from_table}.${f.from_column} → ${f.to_column}` })));
  }
  if (!t.references.length && !t.referencedBy.length) rel.append(el('div', { className: 'muted', textContent: 'No foreign keys.' }));
  view.append(rel);

  // Changes
  view.append(el('h4', { textContent: 'RECENT CHANGES' }));
  if (!t.audit) {
    view.append(
      el(
        'div',
        { className: 'audit-off' },
        el('div', { textContent: 'Change tracking is off.' }),
        el('div', {
          className: 'muted',
          textContent: 'Turning it on adds a feel_audit table and a trigger on each table of this dev database, recording every insert, update and delete.',
        }),
        el('button', { textContent: 'Turn on change tracking', onclick: () => enableAudit(t.name) }),
      ),
    );
    return view;
  }
  view.append(renderChanges(t.changes, false));
  if (t.referencedBy.length || t.references.length) {
    view.append(el('h4', { textContent: 'CHANGES IN RELATED TABLES' }));
    view.append(renderChanges(t.relatedChanges, true));
  }
  return view;
}

function renderChanges(changes, showTableName) {
  if (!changes.length) return el('div', { className: 'muted', textContent: 'No changes recorded yet.' });
  const list = el('div', { className: 'changes' });
  for (const c of changes) {
    const row = c.row_data ?? c.old_data ?? {};
    const line = el(
      'div',
      { className: 'change' },
      el('span', { className: 'muted', textContent: timeAgo(c.changed_at) }),
      el('span', { className: `op ${c.op.toLowerCase()}`, textContent: c.op }),
    );
    if (showTableName) line.append(tableLink(c.table_name));
    line.append(el('span', { className: 'mono', textContent: row.id != null ? `#${row.id}` : '' }));
    line.append(el('span', { className: 'diff', textContent: describeChange(c) }));
    list.append(line);
  }
  return list;
}

// INSERT → the new row's values; UPDATE → only what changed; DELETE → the old row.
function describeChange(c) {
  const fmt = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  if (c.op === 'UPDATE') {
    return Object.keys(c.row_data)
      .filter((k) => JSON.stringify(c.row_data[k]) !== JSON.stringify(c.old_data[k]))
      .map((k) => `${k}: ${fmt(c.old_data[k])} → ${fmt(c.row_data[k])}`)
      .join(', ');
  }
  const row = c.row_data ?? c.old_data;
  return Object.entries(row)
    .filter(([k]) => k !== 'id')
    .map(([k, v]) => `${k}=${fmt(v)}`)
    .join(', ');
}

async function enableAudit(tableName) {
  codeBox.innerHTML = '<div class="status-msg">Installing triggers…</div>';
  const res = await fetch(`${AGENT}/db/audit`, { method: 'POST' });
  if (!res.ok) {
    codeBox.replaceChildren(el('div', { className: 'status-msg', textContent: (await res.json()).error }));
    return;
  }
  showTable(tableName);
}

function tableLink(name, label = name) {
  return el('button', { className: 'db read', textContent: label, onclick: () => showTable(name) });
}

function timeAgo(date) {
  const s = Math.round((Date.now() - new Date(date)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function fetchReach({ file, component }) {
  const key = `${file}#${component}`;
  if (!reachCache.has(key)) {
    const q = new URLSearchParams({ file, component });
    const res = await fetch(`${AGENT}/reach?${q}`);
    const body = res.ok ? await res.json() : {};
    reachCache.set(key, { functions: new Set(body.functions), direct: new Set(body.direct) });
  }
  return reachCache.get(key);
}

// --- Code viewer ------------------------------------------------------------

// params: { file, line, resolve?, index? } — see the agent's /source route.
async function showCode(params) {
  if (current) current.shown = null; // leaving any table view
  panel.classList.remove('table-mode');
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
  if (!shown?.absPath) return; // e.g. a table view — nothing to open
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
