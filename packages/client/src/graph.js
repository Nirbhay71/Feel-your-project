// Graph view — the whole stack for one component as a left-to-right graph.
//
// Solid = seen at runtime; dashed = found statically, not called yet.
//
//   [SalesChart] → [useApi] → [fetchSales] → [getJson] → [GET /api/sales]
//        → [inline handler] → [SELECT … sales.js:8] → [orders] ┄ [users]
//                                                              ┄ [products]
//                                                              ┄ [notifications]
//
// Our data is already layered (component → frontend → route → handler → SQL
// → tables → related tables), so a column layout is enough — no layout
// library needed. Nodes are HTML (easy text + ellipsis), edges are an SVG
// layer underneath. Everything is positioned from fixed sizes, so nothing has
// to be measured in the DOM.

const W = 148; // node width
const H = 52; // node height
const GAP = 36; // horizontal gap between columns
const VGAP = 14; // vertical gap between nodes
const PAD = 16;
const RECENT_MS = 10 * 60 * 1000; // a table "changed recently" = last 10 minutes

// --- Model ------------------------------------------------------------------

// requests:  [{ req, frames }] — frames are the ones owned by the component, innermost first
// possible:  static calls not seen at runtime (agent /possible) — drawn dashed
// tableInfo: Map name → /db/table response (or null if unavailable)
export function buildGraph({ entry, requests, possible = [], tableInfo }) {
  const nodes = new Map();
  const edges = new Map();

  const node = (key, props) => {
    if (!nodes.has(key)) nodes.set(key, { key, depth: 0, ...props });
    return nodes.get(key);
  };
  const edge = (from, to, kind = '') => {
    if (from === to) return;
    // Foreign keys have no direction worth drawing twice (a–b == b–a).
    const k = kind === 'fk' ? [from.key, to.key].sort().join('~') : `${from.key}→${to.key}`;
    if (!edges.has(k)) edges.set(k, { from: from.key, to: to.key, kind });
  };

  const root = node('component', {
    kind: 'component',
    label: entry.component,
    sub: `${short(entry.file)}:${entry.line}`,
    action: { code: { file: entry.file, line: entry.line } },
  });

  for (const { req, frames } of requests) {
    // Frontend: outermost → innermost. The component's own frame is the root.
    let prev = root;
    let depth = 0;

    // A library ran the code on the component's behalf (React Query calling
    // a queryFn): component → [library] → your function. It's the marker just
    // outside the frames the component owns.
    const lib = req.frames?.[frames.length]?.lib;
    const componentOnStack = frames.some((f) => f.file === entry.file && f.component === entry.component);
    if (lib && !componentOnStack) {
      const n = node(`lib:${lib}`, { kind: 'frontend', lib: true, label: lib, sub: 'called your code' });
      n.depth = Math.max(n.depth, ++depth);
      edge(prev, n);
      prev = n;
    }

    for (const f of [...frames].reverse()) {
      if (f.file === entry.file && f.fn === entry.component) continue;
      const n = node(`fe:${f.file}#${f.fn ?? f.line}`, {
        kind: 'frontend',
        label: f.fn ?? '(anonymous)',
        sub: `${short(f.file)}:${f.line}`,
        action: { code: { file: f.file, line: f.line } },
      });
      n.depth = Math.max(n.depth, ++depth);
      edge(prev, n);
      prev = n;
    }

    const b = req.backend;
    if (!b) continue;

    // API route
    const route = node(`route:${b.method} ${b.path}`, { kind: 'route', label: `${b.method} ${b.path}` });
    route.sub = `${req.status} · ${Math.round(req.duration)} ms`;
    edge(prev, route);

    // Handler chain (middleware → handler)
    prev = route;
    b.handlers.forEach((h, i) => {
      const n = node(`handler:${h.file}:${h.line}:${h.index}`, {
        kind: 'handler',
        label: h.name ?? 'inline handler',
        sub: `${short(h.file)}:${h.line}`,
        action: { code: { file: h.file, line: h.line, resolve: 'handler', index: h.index } },
      });
      n.depth = Math.max(n.depth, i);
      if (!route.action) route.action = n.action;
      edge(prev, n);
      prev = n;
    });
    const handler = prev;

    // SQL queries and the tables they touch
    for (const q of b.queries ?? []) {
      const qn = node(`query:${q.file}:${q.line}`, {
        kind: 'query',
        label: q.sql.replace(/\s+/g, ' ').trim(),
        sub: `${short(q.file)}:${q.line}${q.duration != null ? ` · ${Math.round(q.duration)} ms` : ''}`,
        error: !!q.error,
        action: { code: { file: q.file, line: q.line } },
      });
      edge(handler, qn);
      for (const t of q.tables ?? []) {
        const tn = node(`table:${t.name}`, { kind: 'table', label: t.name, action: { table: t.name } });
        if (t.access === 'write') tn.write = true;
        edge(qn, tn, t.access);
      }
    }
  }

  // Static calls that haven't run yet. Nodes they share with runtime calls
  // (same function, route, handler, query or table) are reused; new ones are
  // marked static and drawn dashed, as are their edges.
  const staticNode = (key, props) => {
    const isNew = !nodes.has(key);
    const n = node(key, props);
    if (isNew) n.static = true;
    return n;
  };
  for (const c of possible) {
    let prev = root;
    c.chain.forEach((f, i) => {
      if (i === 0 && f.fn === entry.component) return; // the component itself
      const n = staticNode(`fe:${f.file}#${f.fn}`, {
        kind: 'frontend',
        label: f.fn,
        sub: `${short(f.file)}:${f.line}`,
        action: { code: { file: f.file, line: f.line } },
      });
      n.depth = Math.max(n.depth, i);
      edge(prev, n, 'static');
      prev = n;
    });

    if (!c.route) {
      const n = staticNode(`route:${c.method} ${c.url}`, { kind: 'route', label: `${c.method} ${c.url}`, sub: 'no matching route' });
      edge(prev, n, 'static');
      continue;
    }
    const r = c.route;
    const route = staticNode(`route:${r.method} ${r.path}`, { kind: 'route', label: `${r.method} ${r.path}`, sub: 'not called yet' });
    edge(prev, route, 'static');

    const h = r.handler;
    const handler = staticNode(`handler:${r.file}:${r.line}:${h.index}`, {
      kind: 'handler',
      label: h.name ?? 'inline handler',
      sub: `${short(h.file)}:${h.line}`,
      action: { code: { file: h.file, line: h.line } },
    });
    if (!route.action) route.action = handler.action;
    edge(route, handler, 'static');

    for (const q of r.queries) {
      const qn = staticNode(`query:${q.file}:${q.line}`, {
        kind: 'query',
        label: q.sql.replace(/\s+/g, ' ').trim(),
        sub: `${short(q.file)}:${q.line}`,
        action: { code: { file: q.file, line: q.line } },
      });
      edge(handler, qn, 'static');
      for (const t of q.tables) {
        const tn = staticNode(`table:${t.name}`, { kind: 'table', label: t.name, action: { table: t.name } });
        if (t.access === 'write') tn.write = true;
        edge(qn, tn, t.access === 'write' ? 'static write' : 'static');
      }
    }
  }

  // Related tables via foreign keys (both directions).
  const direct = [...nodes.values()].filter((n) => n.kind === 'table');
  for (const tn of direct) {
    const info = tableInfo.get(tn.label);
    if (!info) continue;
    decorateTable(tn, info);
    const others = [...info.references.map((f) => f.to_table), ...info.referencedBy.map((f) => f.from_table)];
    for (const name of others) {
      const other = node(`table:${name}`, { kind: 'related', label: name, action: { table: name } });
      const otherInfo = tableInfo.get(name);
      if (other.kind === 'related' && otherInfo) decorateTable(other, otherInfo);
      edge(tn, other, 'fk');
    }
  }

  return { nodes, edges };
}

// Row count, and when the table last changed (if change tracking is on).
function decorateTable(n, info) {
  const last = info.changes?.[0]?.changed_at;
  n.sub = `${info.rowCount} rows${n.write ? ' · written' : ''}`;
  if (last) {
    n.changed = Date.now() - new Date(last) < RECENT_MS;
    n.sub = `● changed ${timeAgo(last)}`;
  }
}

// --- Layout -------------------------------------------------------------------

function layout(model) {
  const nodes = [...model.nodes.values()];
  const maxDepth = (kind, plus = 0) => Math.max(0, ...nodes.filter((n) => n.kind === kind).map((n) => n.depth + plus));
  const F = maxDepth('frontend'); // frontend columns 1..F
  const HC = maxDepth('handler', 1); // handler columns

  const stage = {
    component: () => 0,
    frontend: (n) => n.depth,
    route: () => F + 1,
    handler: (n) => F + 2 + n.depth,
    query: () => F + 2 + HC,
    table: () => F + 3 + HC,
    related: () => F + 4 + HC,
  };

  // Drop empty columns so the graph stays compact.
  const used = [...new Set(nodes.map((n) => stage[n.kind](n)))].sort((a, b) => a - b);
  const columns = used.map(() => []);
  for (const n of nodes) columns[used.indexOf(stage[n.kind](n))].push(n);

  // Stack each column, centred against the tallest one.
  const tallest = Math.max(...columns.map((c) => c.length));
  columns.forEach((col, ci) => {
    const offset = ((tallest - col.length) * (H + VGAP)) / 2;
    col.forEach((n, ri) => {
      n.x = PAD + ci * (W + GAP);
      n.y = PAD + offset + ri * (H + VGAP);
    });
  });

  return {
    width: PAD * 2 + columns.length * W + (columns.length - 1) * GAP,
    height: PAD * 2 + tallest * H + (tallest - 1) * VGAP,
  };
}

// --- Rendering ------------------------------------------------------------------

const KIND_LABEL = {
  component: 'Component',
  frontend: 'Frontend',
  route: 'API',
  handler: 'Backend',
  query: 'SQL',
  table: 'Table',
  related: 'Related table',
};

// onSelect(node) is called when a node is clicked.
export function renderGraph(model, { onSelect, activeKey }) {
  const { width, height } = layout(model);
  const wrap = el('div', { className: 'graph' });
  Object.assign(wrap.style, { width: `${width}px`, height: `${height}px` });

  // Which nodes/edges touch each node — for hover highlighting.
  const neighbours = new Map([...model.nodes.keys()].map((k) => [k, new Set([k])]));
  for (const e of model.edges.values()) {
    neighbours.get(e.from).add(e.to);
    neighbours.get(e.to).add(e.from);
  }

  // Edges (SVG layer, under the nodes)
  const svg = svgEl('svg', { width, height, class: 'edges' });
  svg.append(
    svgEl('defs', {}, svgEl('marker', { id: 'arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto' },
      svgEl('path', { d: 'M0,0 L8,4 L0,8 z', class: 'arrowhead' }))),
  );
  const edgeEls = [];
  for (const e of model.edges.values()) {
    const a = model.nodes.get(e.from);
    const b = model.nodes.get(e.to);
    const path = svgEl('path', { d: edgePath(a, b), class: `edge ${e.kind}` });
    if (e.kind !== 'fk') path.setAttribute('marker-end', 'url(#arrow)');
    path.dataset.from = e.from;
    path.dataset.to = e.to;
    svg.append(path);
    edgeEls.push(path);
  }
  wrap.append(svg);

  // Nodes
  const nodeEls = [];
  for (const n of model.nodes.values()) {
    const kindClass = n.kind === 'table' && n.write ? 'table write' : n.lib ? 'frontend lib' : n.kind;
    const div = el(
      'div',
      {
        className: `gnode ${kindClass}${n.static ? ' static-node' : ''}${n.changed ? ' changed' : ''}${n.error ? ' error' : ''}${n.key === activeKey ? ' active' : ''}`,
        title: `${n.label}\n${n.sub ?? ''}`,
      },
      el('div', { className: 'k', textContent: n.lib ? 'Library' : KIND_LABEL[n.kind] }),
      el('div', { className: 'l', textContent: n.label }),
      el('div', { className: 's', textContent: n.sub ?? '' }),
    );
    Object.assign(div.style, { left: `${n.x}px`, top: `${n.y}px`, width: `${W}px`, height: `${H}px` });
    div.dataset.key = n.key;
    if (n.action) div.onclick = () => onSelect(n);
    else div.classList.add('static');

    div.onmouseenter = () => {
      const near = neighbours.get(n.key);
      wrap.classList.add('hovering');
      nodeEls.forEach((d) => d.classList.toggle('hot', near.has(d.dataset.key)));
      edgeEls.forEach((p) => p.classList.toggle('hot', p.dataset.from === n.key || p.dataset.to === n.key));
    };
    div.onmouseleave = () => wrap.classList.remove('hovering');
    wrap.append(div);
    nodeEls.push(div);
  }

  return wrap;
}

// A smooth curve from the right edge of a to the left edge of b. Two nodes in
// the same column (e.g. two tables linked by a foreign key) get an arc that
// bulges out to the right instead.
function edgePath(a, b) {
  const ay = a.y + H / 2;
  const by = b.y + H / 2;
  if (a.x === b.x) {
    const x = a.x + W;
    const bulge = 28 + Math.abs(by - ay) / 6;
    return `M${x},${ay} C${x + bulge},${ay} ${x + bulge},${by} ${x},${by}`;
  }
  const [from, to, fy, ty] = a.x < b.x ? [a, b, ay, by] : [b, a, by, ay];
  const x1 = from.x + W;
  const x2 = to.x;
  const mid = (x2 - x1) / 2;
  return `M${x1},${fy} C${x1 + mid},${fy} ${x2 - mid},${ty} ${x2},${ty}`;
}

export const GRAPH_CSS = `
  .graph { position: absolute; top: 0; left: 0; }
  .graph .edges { position: absolute; inset: 0; overflow: visible; }
  .edge { fill: none; stroke: #586069; stroke-width: 1.5; transition: opacity .15s; }
  .edge.write { stroke: #f97583; }
  .edge.fk { stroke: #6a737d; stroke-dasharray: 4 4; }
  .edge.static { stroke-dasharray: 6 4; opacity: .7; }
  .gnode.static-node { border-style: dashed; border-left-style: dashed; background: #2a3036; opacity: .8; }
  .arrowhead { fill: #586069; }
  .gnode {
    position: absolute; box-sizing: border-box; padding: 5px 8px;
    background: #2f363d; border: 1px solid #444d56; border-left: 3px solid var(--c, #586069);
    border-radius: 8px; cursor: pointer; transition: opacity .15s, border-color .15s;
  }
  .gnode.static { cursor: default; }
  .gnode:hover, .gnode.active { border-color: var(--c); background: #363e46; }
  .gnode .k { font-size: 10px; line-height: 13px; color: #959da5; text-transform: uppercase; letter-spacing: .04em; }
  .gnode .l, .gnode .s { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .gnode .l { font: 12px/16px ui-monospace, monospace; color: #e1e4e8; }
  .gnode .s { font-size: 10.5px; line-height: 14px; color: #6a737d; }
  .gnode.component { --c: #e5484d; }
  .gnode.frontend  { --c: #b392f0; }
  .gnode.lib       { --c: #6a737d; cursor: default; }
  .gnode.route     { --c: #79b8ff; }
  .gnode.handler   { --c: #ffab70; }
  .gnode.query     { --c: #959da5; }
  .gnode.table     { --c: #79b8ff; }
  .gnode.table.write { --c: #f97583; }
  .gnode.related   { --c: #6a737d; border-style: dashed; border-left-style: solid; }
  .gnode.changed .s { color: #85e89d; }
  .gnode.error .s { color: #f97583; }
  .graph.hovering .gnode:not(.hot) { opacity: .4; }
  .graph.hovering .edge:not(.hot) { opacity: .15; }
  .graph.hovering .edge.hot { stroke-width: 2.5; }
`;

// --- Helpers ----------------------------------------------------------------------

const short = (file) => file.split(/[\\/]/).pop();

function timeAgo(date) {
  const s = Math.round((Date.now() - new Date(date)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}
