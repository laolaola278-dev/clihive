// The window: a grid of small CLI panes, a hideable orchestrator on the right,
// and a trace feed that shows whether messages actually landed.

const WS_CLIENT = {
  PANE_CREATE: 'pane.create',
  PANE_INPUT: 'pane.input',
  PANE_RESIZE: 'pane.resize',
  PANE_KILL: 'pane.kill',
  PANE_SUBSCRIBE: 'pane.subscribe',
  SEND: 'message.send',
  ORCH_ASK: 'orch.ask',
};

const el = (id) => document.getElementById(id);

const dom = {
  body: document.querySelector('.body'),
  grid: el('grid'),
  gridEmpty: el('grid-empty'),
  status: el('status'),
  addPane: el('add-pane'),
  emptyAdd: el('empty-add'),
  newPaneMode: el('new-pane-mode'),
  orch: el('orchestrator'),
  toggleOrch: el('toggle-orch'),
  closeOrch: el('close-orch'),
  orchMode: el('orch-mode'),
  orchLog: el('orch-log'),
  orchTrace: el('orch-trace'),
  orchForm: el('orch-form'),
  orchInput: el('orch-input'),
  orchTarget: el('orch-target'),
  composerHint: el('composer-hint'),
  sharedLog: el('shared-log'),
  traceFilter: el('trace-filter'),
  traceDrawer: el('trace-drawer'),
  traceLog: el('trace-log'),
  toggleTrace: el('toggle-trace'),
  closeTrace: el('close-trace'),
};

const token = new URLSearchParams(location.search).get('token') ?? '';

/** paneId -> { term, fit, pane, node, unread } */
const panes = new Map();
let focusedPane = null;
/** Every trace event we have seen, for re-filtering. */
const traceEvents = [];
let ws = null;
let reconnectDelay = 500;

// --------------------------------------------------------------------------
// helpers

function time(ts) {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function setStatus(text, state) {
  dom.status.textContent = text;
  dom.status.dataset.state = state ?? '';
}

function atBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 40;
}

/** Append to a log, holding the scroll position unless already at the bottom. */
function appendTo(node, child, cap = 500) {
  const stick = atBottom(node);
  node.append(child);
  while (node.childElementCount > cap) node.firstElementChild.remove();
  if (stick) node.scrollTop = node.scrollHeight;
}

function send(frame) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

// --------------------------------------------------------------------------
// panes

function newTerminal() {
  const term = new window.Terminal({
    fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: {
      background: '#08090b',
      foreground: '#dfe3ea',
      cursor: '#e8a33d',
      selectionBackground: '#33373f',
      black: '#0b0c0e',
      brightBlack: '#5b6270',
      red: '#d9704a',
      green: '#5cb87a',
      yellow: '#e8a33d',
      blue: '#6f8fb5',
      magenta: '#b58fd0',
      cyan: '#5fb3b3',
      white: '#dfe3ea',
    },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}

function paneChrome(pane) {
  const node = document.createElement('div');
  node.className = 'pane';
  node.dataset.paneId = pane.id;
  node.dataset.alive = String(pane.alive);
  node.dataset.focused = 'false';

  node.innerHTML = `
    <div class="pane-head">
      <span class="pane-dot"></span>
      <span class="pane-id">${pane.id}</span>
      <span class="pane-label"></span>
      <span class="pane-meta">
        <span class="pane-unread" hidden></span>
        <span class="pane-badge" data-mode="${pane.deliveryMode}">${pane.deliveryMode}</span>
        <span class="pane-pid">pid ${pane.pid ?? '-'}</span>
        <button class="icon-btn pane-kill" type="button" title="Close pane">&times;</button>
      </span>
    </div>
    <div class="pane-term"></div>
  `;
  // Label via textContent so a hostile label cannot inject markup.
  node.querySelector('.pane-label').textContent = pane.label;
  return node;
}

function focusPane(paneId) {
  focusedPane = paneId;
  for (const [id, entry] of panes) {
    entry.node.dataset.focused = String(id === paneId);
  }
  const entry = panes.get(paneId);
  if (entry) {
    entry.term.focus();
    entry.unread = 0;
    renderUnread(entry);
  }
  syncTargets();
}

function renderUnread(entry) {
  const badge = entry.node.querySelector('.pane-unread');
  if (entry.unread > 0) {
    badge.textContent = String(entry.unread);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function mountPane(pane) {
  if (panes.has(pane.id)) return panes.get(pane.id);

  const node = paneChrome(pane);
  const { term, fit } = newTerminal();
  const entry = { term, fit, pane, node, unread: 0 };
  panes.set(pane.id, entry);

  dom.grid.append(node);
  term.open(node.querySelector('.pane-term'));

  term.onData((data) => send({ type: WS_CLIENT.PANE_INPUT, paneId: pane.id, data }));
  node.addEventListener('mousedown', () => focusPane(pane.id));
  node.querySelector('.pane-kill').addEventListener('click', (event) => {
    event.stopPropagation();
    send({ type: WS_CLIENT.PANE_KILL, paneId: pane.id });
  });

  // Fit once laid out, then tell the PTY the real geometry.
  requestAnimationFrame(() => {
    fitPane(entry);
    send({ type: WS_CLIENT.PANE_SUBSCRIBE, paneId: pane.id });
  });

  refreshEmpty();
  syncTargets();
  if (!focusedPane) focusPane(pane.id);
  return entry;
}

function fitPane(entry) {
  try {
    entry.fit.fit();
    send({
      type: WS_CLIENT.PANE_RESIZE,
      paneId: entry.pane.id,
      cols: entry.term.cols,
      rows: entry.term.rows,
    });
  } catch {
    // The pane is not laid out yet; the next resize pass will handle it.
  }
}

function dropPane(paneId) {
  const entry = panes.get(paneId);
  if (!entry) return;
  entry.term.dispose();
  entry.node.remove();
  panes.delete(paneId);
  if (focusedPane === paneId) {
    focusedPane = null;
    const next = panes.keys().next();
    if (!next.done) focusPane(next.value);
  }
  refreshEmpty();
  syncTargets();
}

function syncPaneList(list) {
  const seen = new Set();
  for (const pane of list) {
    seen.add(pane.id);
    const entry = panes.get(pane.id);
    if (!entry) {
      mountPane(pane);
      continue;
    }
    entry.pane = pane;
    entry.node.dataset.alive = String(pane.alive);
    entry.node.querySelector('.pane-pid').textContent = `pid ${pane.pid ?? '-'}`;
  }
  for (const id of [...panes.keys()]) {
    if (!seen.has(id)) dropPane(id);
  }
}

function refreshEmpty() {
  dom.gridEmpty.hidden = panes.size > 0;
}

/** Keep the orchestrator target list in step with the roster. */
function syncTargets() {
  const previous = dom.orchTarget.value;
  dom.orchTarget.textContent = '';

  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = 'all panes';
  dom.orchTarget.append(all);

  for (const [id, entry] of panes) {
    if (!entry.pane.alive) continue;
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `${id} · ${entry.pane.label}`;
    dom.orchTarget.append(option);
  }

  dom.orchTarget.value = [...dom.orchTarget.options].some((o) => o.value === previous)
    ? previous
    : 'all';
  updateComposerHint();
}

function updateComposerHint() {
  const target = dom.orchTarget.value;
  dom.composerHint.textContent = target === 'all'
    ? `relays to ${panes.size} pane(s)`
    : `relays to ${target} only`;
}

// --------------------------------------------------------------------------
// logs

function renderOrchEntry(entry) {
  const node = document.createElement('div');
  node.className = 'entry';
  node.dataset.role = entry.role;

  const head = document.createElement('div');
  head.className = 'entry-head';
  const who = document.createElement('span');
  who.className = 'entry-who';
  who.textContent = entry.role === 'human' ? 'you' : entry.role;
  const when = document.createElement('span');
  when.textContent = time(entry.ts);
  head.append(who, when);
  if (entry.to) {
    const to = document.createElement('span');
    to.textContent = `-> ${entry.to}`;
    head.append(to);
  }

  const body = document.createElement('div');
  body.className = 'entry-body';
  body.textContent = entry.text;

  node.append(head, body);

  if (Array.isArray(entry.deliveries) && entry.deliveries.length > 0) {
    const receipts = document.createElement('div');
    receipts.className = 'receipts';
    for (const d of entry.deliveries) {
      const chip = document.createElement('span');
      chip.className = 'receipt';
      chip.dataset.ok = String(Boolean(d.ok));
      chip.textContent = d.ok
        ? `${d.target} ${d.channel}`
        : `${d.target} failed: ${d.reason ?? '?'}`;
      receipts.append(chip);
    }
    node.append(receipts);
  }

  appendTo(dom.orchLog, node);
}

function renderSharedMessage(msg) {
  const node = document.createElement('div');
  node.className = 'entry';
  node.dataset.role = msg.from === 'orchestrator' ? 'orchestrator' : 'pane';

  const head = document.createElement('div');
  head.className = 'entry-head';
  const who = document.createElement('span');
  who.className = 'entry-who';
  who.textContent = `${msg.from} -> ${msg.to}`;
  const when = document.createElement('span');
  when.textContent = time(msg.ts);
  const kind = document.createElement('span');
  kind.textContent = msg.kind;
  head.append(who, when, kind);

  const body = document.createElement('div');
  body.className = 'entry-body';
  body.textContent = msg.text;

  node.append(head, body);
  appendTo(dom.sharedLog, node);
}

const TRACE_SKIP = new Set(['seq', 'id', 'ts', 'kind']);

function traceRow(event) {
  const row = document.createElement('div');
  row.className = 'trace-row';
  row.dataset.kind = event.kind;

  const when = document.createElement('span');
  when.className = 'trace-time';
  when.textContent = time(event.ts);

  const kind = document.createElement('span');
  kind.className = 'trace-kind';
  kind.textContent = event.kind;

  const detail = document.createElement('span');
  detail.className = 'trace-detail';
  detail.textContent = Object.entries(event)
    .filter(([key]) => !TRACE_SKIP.has(key))
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join('  ');

  row.append(when, kind, detail);
  return row;
}

function traceMatches(event, needle) {
  if (!needle) return true;
  const text = `${event.kind} ${JSON.stringify(event)}`.toLowerCase();
  return text.includes(needle.toLowerCase());
}

function pushTrace(event) {
  traceEvents.push(event);
  if (traceEvents.length > 3000) traceEvents.shift();

  appendTo(dom.traceLog, traceRow(event), 800);
  if (traceMatches(event, dom.traceFilter.value.trim())) {
    appendTo(dom.orchTrace, traceRow(event), 800);
  }
}

function rebuildFilteredTrace() {
  const needle = dom.traceFilter.value.trim();
  dom.orchTrace.textContent = '';
  for (const event of traceEvents.slice(-800)) {
    if (traceMatches(event, needle)) dom.orchTrace.append(traceRow(event));
  }
  dom.orchTrace.scrollTop = dom.orchTrace.scrollHeight;
}

/** Bump a pane's unread badge when a message is pushed to it. */
function noteDelivery(delivery) {
  const entry = panes.get(delivery.target);
  if (!entry || !delivery.ok) return;
  if (delivery.channel === 'cli') {
    entry.unread = 0;
  } else if (delivery.target !== focusedPane) {
    entry.unread += 1;
  }
  renderUnread(entry);
}

// --------------------------------------------------------------------------
// websocket

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.addEventListener('open', () => {
    reconnectDelay = 500;
    setStatus('connected', 'live');
  });

  ws.addEventListener('message', (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    handleFrame(frame);
  });

  ws.addEventListener('close', () => {
    setStatus(`disconnected · retrying in ${Math.round(reconnectDelay / 100) / 10}s`, 'down');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(8000, reconnectDelay * 2);
  });

  ws.addEventListener('error', () => setStatus('connection error', 'down'));
}

function handleFrame(frame) {
  switch (frame.type) {
    case 'hello': {
      syncPaneList(frame.panes ?? []);
      for (const msg of frame.transcript ?? []) renderSharedMessage(msg);
      for (const entry of frame.orchestrator ?? []) renderOrchEntry(entry);
      for (const event of frame.trace ?? []) pushTrace(event);
      applyStatus(frame.status);
      break;
    }
    case 'pane.list':
      syncPaneList(frame.panes ?? []);
      break;
    case 'pane.created':
      mountPane(frame.pane);
      focusPane(frame.pane.id);
      break;
    case 'pane.data': {
      const entry = panes.get(frame.paneId);
      if (entry && frame.data) entry.term.write(frame.data);
      break;
    }
    case 'pane.exit': {
      const entry = panes.get(frame.paneId);
      if (entry) {
        entry.node.dataset.alive = 'false';
        entry.term.write(`\r\n\u001b[2m[pane exited: code ${frame.exit?.code ?? '?'}]\u001b[0m\r\n`);
      }
      syncTargets();
      break;
    }
    case 'message':
      renderSharedMessage(frame.message);
      break;
    case 'delivery':
      noteDelivery(frame.delivery);
      break;
    case 'trace':
      pushTrace(frame.event);
      break;
    case 'orch.reply':
      renderOrchEntry(frame.entry);
      break;
    case 'error':
      setStatus(`error: ${frame.error}`, 'down');
      break;
    default:
      break;
  }
}

function applyStatus(status) {
  if (!status) return;
  const mode = status.orchestrator?.mode ?? 'manual';
  dom.orchMode.textContent = status.orchestrator?.model
    ? `${mode} · ${status.orchestrator.model}`
    : mode;
  dom.orchMode.dataset.mode = mode;
  setStatus(`${status.panes?.alive ?? 0} pane(s) · ${status.traceEvents ?? 0} trace events`, 'live');
}

// --------------------------------------------------------------------------
// wiring

function setOrchOpen(open) {
  dom.orch.dataset.open = String(open);
  dom.body.dataset.orch = String(open);
  dom.toggleOrch.setAttribute('aria-pressed', String(open));
  // The grid just changed width, so every terminal needs to re-fit.
  setTimeout(fitAll, 200);
  if (open) dom.orchInput.focus();
}

function setTraceOpen(open) {
  dom.traceDrawer.dataset.open = String(open);
  dom.body.dataset.trace = String(open);
  dom.toggleTrace.setAttribute('aria-pressed', String(open));
  setTimeout(fitAll, 200);
}

function fitAll() {
  for (const entry of panes.values()) fitPane(entry);
}

function addPane() {
  send({
    type: WS_CLIENT.PANE_CREATE,
    spec: { deliveryMode: dom.newPaneMode.value },
  });
}

dom.addPane.addEventListener('click', addPane);
dom.emptyAdd.addEventListener('click', addPane);

dom.toggleOrch.addEventListener('click', () => setOrchOpen(dom.orch.dataset.open !== 'true'));
dom.closeOrch.addEventListener('click', () => setOrchOpen(false));
dom.toggleTrace.addEventListener('click', () => setTraceOpen(dom.traceDrawer.dataset.open !== 'true'));
dom.closeTrace.addEventListener('click', () => setTraceOpen(false));

dom.orchTarget.addEventListener('change', updateComposerHint);
dom.traceFilter.addEventListener('input', rebuildFilteredTrace);

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) {
      const active = other === tab;
      other.classList.toggle('is-active', active);
      other.setAttribute('aria-selected', String(active));
    }
    for (const panel of document.querySelectorAll('.tab-panel')) {
      panel.classList.toggle('is-active', panel.dataset.panel === tab.dataset.tab);
    }
  });
}

function submitOrch() {
  const text = dom.orchInput.value.trim();
  if (!text) return;
  send({ type: WS_CLIENT.ORCH_ASK, text, to: dom.orchTarget.value });
  dom.orchInput.value = '';
}

dom.orchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitOrch();
});

dom.orchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitOrch();
  }
});

// Ctrl/Cmd+J toggles the orchestrator; Ctrl/Cmd+Shift+T the trace drawer.
window.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === 'j') {
    event.preventDefault();
    setOrchOpen(dom.orch.dataset.open !== 'true');
  } else if (key === 't' && event.shiftKey) {
    event.preventDefault();
    setTraceOpen(dom.traceDrawer.dataset.open !== 'true');
  }
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fitAll, 120);
});

// Re-fit when the grid itself reflows (a pane added, the drawer opened).
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitAll, 120);
  }).observe(dom.grid);
}

refreshEmpty();
connect();
