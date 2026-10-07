// clihive window — Bridge layout.
// 36px titlebar · 240px workspace sidebar · hero terminal grid · 326px
// mission-control deck (Fleet + Orchestrator + Shared + Trace) · palette.

const WS_CLIENT = {
  PANE_CREATE: 'pane.create',
  PANE_INPUT: 'pane.input',
  PANE_RESIZE: 'pane.resize',
  PANE_KILL: 'pane.kill',
  PANE_SUBSCRIBE: 'pane.subscribe',
  SEND: 'message.send',
  ORCH_ASK: 'orch.ask',
};

const $ = (id) => document.getElementById(id);

const dom = {
  body: $('body'),
  sidebar: $('sidebar'),
  sidebarRail: $('sidebar-rail'),
  sidebarHide: $('sidebar-hide'),
  wsList: $('ws-list'),
  wsAdd: $('ws-add'),
  wsCount: $('ws-count'),
  wsName: $('ws-name'),
  grid: $('grid'),
  gridEmpty: $('grid-empty'),
  gridEmptyText: $('grid-empty-text'),
  status: $('status'),
  addPane: $('add-pane'),
  emptyAdd: $('empty-add'),
  newPaneMode: $('new-pane-mode'),
  openPalette: $('open-palette'),
  palette: $('palette'),
  paletteInput: $('palette-input'),
  paletteList: $('palette-list'),
  orch: $('orchestrator'),
  toggleOrch: $('toggle-orch'),
  closeOrch: $('close-orch'),
  orchLog: $('orch-log'),
  orchForm: $('orch-form'),
  orchInput: $('orch-input'),
  orchTarget: $('orch-target'),
  composerHint: $('composer-hint'),
  sharedLog: $('shared-log'),
  traceFilter: $('trace-filter'),
  orchTrace: $('orch-trace'),
  traceDrawer: $('trace-drawer'),
  traceLog: $('trace-log'),
  toggleTrace: $('toggle-trace'),
  closeTrace: $('close-trace'),
  fleet: $('fleet'),
  fleetLabel: $('fleet-label'),
  fleetList: $('fleet-list'),
  collabPanel: $('collab-panel'),
  collabAgents: $('collab-agents'),
  collabAgentsLabel: $('collab-agents-label'),
  collabAgentForm: $('collab-agent-form'),
  caProvider: $('ca-provider'),
  caPermission: $('ca-permission'),
  caLabel: $('ca-label'),
  caCwd: $('ca-cwd'),
  collabRuns: $('collab-runs'),
  collabRunsLabel: $('collab-runs-label'),
  collabRunForm: $('collab-run-form'),
  crObjective: $('cr-objective'),
  crAgents: $('cr-agents'),
  crCriteria: $('cr-criteria'),
  crPermission: $('cr-permission'),
  crPlan: $('cr-plan'),
  crHint: $('cr-hint'),
  collabTasks: $('collab-tasks'),
  collabTasksLabel: $('collab-tasks-label'),
  collabEvents: $('collab-events'),
  collabQuestion: $('collab-question'),
  collabQText: $('collab-q-text'),
  collabQInput: $('collab-q-input'),
  collabQSend: $('collab-q-send'),
  vitalRunning: $('vital-running'),
  vitalRunningN: $('vital-running-n'),
  vitalAttention: $('vital-attention'),
  vitalAttentionN: $('vital-attention-n'),
  settings: $('settings'),
  openSettings: $('open-settings'),
  closeSettings: $('close-settings'),
  setTheme: $('set-theme'),
  setBg: $('set-bg'),
  setBgFit: $('set-bg-fit'),
  setBgFit: $('set-bg-fit'),
  setBgOpacity: $('set-bg-opacity'),
  setScanlines: $('set-scanlines'),
  setGlow: $('set-glow'),
  setBgClear: $('set-bg-clear'),
};

const token = new URLSearchParams(location.search).get('token') ?? '';

/** paneId -> { term, fit, pane, node, unread, lastOutputAt } */
const panes = new Map();
let focusedPane = null;
const traceEvents = [];
let ws = null;
let reconnectDelay = 500;

// workspaces are client-side groupings of pane ids
const workspaces = new Map([['main', { name: 'main', panes: [] }]]);
let activeWorkspace = 'main';

// ---------------------------------------------------------------- helpers

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

function appendTo(node, child, cap = 500) {
  const stick = atBottom(node);
  node.append(child);
  while (node.childElementCount > cap) node.firstElementChild.remove();
  if (stick) node.scrollTop = node.scrollHeight;
}

function send(frame) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

// ---------------------------------------------------------------- terminals

const TERM_THEMES = {
  amber: {
    background: '#101012', foreground: '#bdbab4', cursor: '#e8a33d',
    selectionBackground: '#3a3833',
    black: '#28282d', red: '#d96c6c', green: '#8fbf7f', yellow: '#d4b36a',
    blue: '#8aaee0', magenta: '#c79bc7', cyan: '#8fbfb2', white: '#bdbab4',
    brightBlack: '#5c5a55', brightRed: '#e28a8a', brightGreen: '#a8d19a',
    brightYellow: '#e2c687', brightBlue: '#a6c3ea', brightMagenta: '#d7b3d7',
    brightCyan: '#a8d1c6', brightWhite: '#efeeec',
  },
  matrix: {
    background: '#020502', foreground: '#00ff41', cursor: '#00ff41',
    selectionBackground: '#0e3a1c',
    black: '#062008', red: '#ff5f56', green: '#00ff41', yellow: '#7cf2a4',
    blue: '#00d9ff', magenta: '#3be873', cyan: '#00d9ff', white: '#7cf2a4',
    brightBlack: '#1b9c4d', brightRed: '#ff8a80', brightGreen: '#3bff70',
    brightYellow: '#b0ffea', brightBlue: '#66e5ff', brightMagenta: '#7cf2a4',
    brightCyan: '#8de8ff', brightWhite: '#eafff0',
  },
  void: {
    background: '#050506', foreground: '#e0e0e0', cursor: '#ffffff',
    selectionBackground: '#2a2a2e',
    black: '#16161a', red: '#e08a8a', green: '#a8d1a0', yellow: '#c0c0a0',
    blue: '#a8a8ff', magenta: '#c0a8d8', cyan: '#a0c8c8', white: '#e0e0e0',
    brightBlack: '#3c3c44', brightRed: '#f0a0a0', brightGreen: '#c0e0b8',
    brightYellow: '#d8d8b8', brightBlue: '#c0c0ff', brightMagenta: '#d8c0e8',
    brightCyan: '#b8e0e0', brightWhite: '#ffffff',
  },
  neon: {
    background: '#0a0515', foreground: '#f5e8ff', cursor: '#ff2e9a',
    selectionBackground: '#4a1a6e',
    black: '#1b0f38', red: '#ff3860', green: '#39ff8f', yellow: '#ffd23f',
    blue: '#22e8ff', magenta: '#ff2e9a', cyan: '#22e8ff', white: '#f5e8ff',
    brightBlack: '#7a5a99', brightRed: '#ff6b8f', brightGreen: '#7affc0',
    brightYellow: '#ffe587', brightBlue: '#7af3ff', brightMagenta: '#ff7ac4',
    brightCyan: '#7af3ff', brightWhite: '#ffffff',
  },
};

function termTheme() {
  return TERM_THEMES[settings.theme] ?? TERM_THEMES.amber;
}

function newTerminal() {
  const term = new window.Terminal({
    fontFamily: '"Cascadia Code","Cascadia Mono","JetBrains Mono",Consolas,monospace',
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: termTheme(),
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}

// ---------------------------------------------------------------- panes

function paneChrome(pane) {
  const node = document.createElement('div');
  node.className = 'pane';
  node.dataset.paneId = pane.id;
  node.dataset.alive = String(pane.alive);
  node.dataset.focused = 'false';
  // The server recognized what runs in this pane; its flavor paints the pane's
  // identity (badge + id color) with the CLI's own accent.
  const flavor = pane.flavor ?? null;
  node.dataset.flavor = flavor?.id ?? 'generic';
  if (flavor?.accent) node.style.setProperty('--flavor', flavor.accent);
  node.innerHTML = `
    <div class="pane-head">
      <span class="pane-dot"></span>
      <span class="pane-id">${pane.id}</span>
      <span class="pane-label"></span>
      <span class="pane-meta">
        <span class="pane-flavor" title="${flavor?.note ?? 'unknown CLI'}"></span>
        <span class="pane-held" hidden title="Held back while a full-screen app owns this pane"></span>
        <span class="pane-geom" title="terminal cols x rows"></span>
        <span class="pane-unread" hidden></span>
        <span class="pane-badge" data-mode="${pane.deliveryMode}">${pane.deliveryMode}</span>
        <button class="icon-btn pane-kill" type="button" title="Close pane">&times;</button>
      </span>
    </div>
    <div class="pane-term"></div>`;
  node.querySelector('.pane-label').textContent = pane.label;
  node.querySelector('.pane-flavor').textContent = flavor?.label ?? 'cli';
  return node;
}

function focusPane(paneId) {
  focusedPane = paneId;
  for (const [id, entry] of panes) entry.node.dataset.focused = String(id === paneId);
  const entry = panes.get(paneId);
  if (entry) { entry.term.focus(); entry.unread = 0; renderUnread(entry); }
  syncTargets();
  renderFleet();
}

function renderUnread(entry) {
  const badge = entry.node.querySelector('.pane-unread');
  if (entry.unread > 0) { badge.textContent = String(entry.unread); badge.hidden = false; }
  else badge.hidden = true;
}

function mountPane(pane) {
  if (panes.has(pane.id)) return panes.get(pane.id);
  const node = paneChrome(pane);
  const { term, fit } = newTerminal();
  // `cursor` is how many chars of this pane's stream have been painted; `held`
  // is the server's count of injected messages waiting for the screen back.
  const entry = { term, fit, pane, node, unread: 0, lastOutputAt: 0, cursor: 0, held: 0 };
  panes.set(pane.id, entry);
  workspaces.get(activeWorkspace)?.panes.push(pane.id);

  dom.grid.append(node);
  term.open(node.querySelector('.pane-term'));
  term.onData((data) => send({ type: WS_CLIENT.PANE_INPUT, paneId: pane.id, data }));
  node.addEventListener('mousedown', () => focusPane(pane.id));
  node.querySelector('.pane-kill').addEventListener('click', (e) => {
    e.stopPropagation();
    send({ type: WS_CLIENT.PANE_KILL, paneId: pane.id });
  });

  requestAnimationFrame(() => { fitPane(entry); send({ type: WS_CLIENT.PANE_SUBSCRIBE, paneId: pane.id }); });
  applyWorkspaceFilter(); syncTargets(); renderWorkspaces(); renderFleet();
  if (!focusedPane) focusPane(pane.id);
  return entry;
}

function fitPane(entry) {
  // A pane that is hidden (workspace filter) or not laid out yet has no usable
  // box: fitting it would compute a bogus geometry and resize the PTY to match,
  // which makes a full-screen app redraw at the wrong size and smear output.
  if (entry.node.hidden || !entry.node.isConnected) return;
  const box = entry.node.getBoundingClientRect();
  if (box.width < 40 || box.height < 40) return;
  try {
    entry.fit.fit();
    const geo = entry.node.querySelector('.pane-geom');
    if (geo) geo.textContent = `${entry.term.cols}×${entry.term.rows}`;
    send({ type: WS_CLIENT.PANE_RESIZE, paneId: entry.pane.id, cols: entry.term.cols, rows: entry.term.rows });
  } catch { /* not laid out yet */ }
}

function fitAll() { for (const entry of panes.values()) fitPane(entry); }

// ---------------------------------------------------------------- stream integrity
//
// Two paths deliver a pane's bytes to this window: the live broadcast, and the
// scrollback replay that answers a subscribe. Without a shared coordinate system
// they paint the same bytes twice — a shell shows doubled lines, and a full-screen
// TUI, which repaints by absolute cursor position, smears one frame over another
// and over the scrollback. That smear is the "overlapping context" a codex pane
// shows. So every frame carries [from,to) in the pane's own stream and each byte
// is painted exactly once.

function applyStreamFrame(entry, frame) {
  const data = frame.data ?? '';
  if (frame.replay) {
    // The window is the authoritative recent state of the pane, so reset and
    // repaint from it instead of appending over frames that already arrived.
    // `preamble` puts this terminal into the mode state the stream is really in:
    // without it, a TUI that entered the alternate screen before the window
    // starts paints absolute-positioned frames onto the normal buffer.
    entry.term.reset();
    entry.term.write((frame.preamble || '') + data);
    entry.cursor = typeof frame.to === 'number' ? frame.to : data.length;
    return true;
  }
  const to = typeof frame.to === 'number' ? frame.to : entry.cursor + data.length;
  const from = typeof frame.from === 'number' ? frame.from : entry.cursor;
  if (to <= entry.cursor) return false; // already painted
  // Trim only the part this window has already seen. Live frames are contiguous,
  // so the overlap is always a prefix.
  entry.term.write(data.slice(Math.max(0, entry.cursor - from)));
  entry.cursor = to;
  return true;
}

// ---------------------------------------------------------------- TUI-safe injection
//
// A hive message in `display` mode is painted into the pane's viewport. That is
// safe for a shell, but a full-screen TUI (codex, claude, htop, less) owns the
// screen: foreign text written into its buffer stays there as garbage woven
// through its own frame, because such an app only redraws the cells it changed.
// The hive therefore holds the message server-side until the app gives the
// screen back, and reports how many are waiting. The count lives on the server
// because that is where it can be trusted — on Windows ConPTY swallows the
// child's alternate-screen switch, so this terminal's own buffer type never
// reports it. Nothing is lost while held: the message is also on the shared
// transcript, in the deck, and pullable with `hive inbox`.

function setHeld(entry, count) {
  entry.held = count;
  const chip = entry.node.querySelector('.pane-held');
  if (!chip) return;
  if (count > 0) {
    chip.textContent = `◈ ${count} held`;
    chip.hidden = false;
  } else {
    chip.hidden = true;
  }
}

function dropPane(paneId) {
  const entry = panes.get(paneId);
  if (!entry) return;
  entry.term.dispose();
  entry.node.remove();
  panes.delete(paneId);
  for (const ws of workspaces.values()) ws.panes = ws.panes.filter((id) => id !== paneId);
  if (focusedPane === paneId) {
    focusedPane = null;
    // prefer a pane the active workspace still shows over a hidden one
    const visibleFirst = [...panes.keys()].find((id) => workspaceOf(id) === activeWorkspace);
    const nextId = visibleFirst ?? panes.keys().next();
    if (typeof nextId === 'string') focusPane(nextId);
    else if (nextId && !nextId.done) focusPane(nextId.value);
  }
  applyWorkspaceFilter(); syncTargets(); renderWorkspaces(); renderFleet();
}

function syncPaneList(list) {
  const seen = new Set();
  for (const pane of list) {
    seen.add(pane.id);
    const entry = panes.get(pane.id);
    if (!entry) { mountPane(pane); continue; }
    entry.pane = pane;
    entry.node.dataset.alive = String(pane.alive);
  }
  for (const id of [...panes.keys()]) if (!seen.has(id)) dropPane(id);
  applyWorkspaceFilter(); renderFleet(); updateVitals();
}

function refreshEmpty() {
  const visible = visiblePaneCount();
  dom.gridEmpty.hidden = visible > 0;
  dom.gridEmptyText.textContent = (panes.size > 0 && visible === 0)
    ? 'This workspace has no panes.'
    : 'No panes yet.';
}

/** Workspaces are a view filter: the hero grid shows the active one only. */
function workspaceOf(paneId) {
  for (const [id, w] of workspaces) if (w.panes.includes(paneId)) return id;
  return null;
}

function visiblePaneCount() {
  const w = workspaces.get(activeWorkspace);
  if (!w) return panes.size;
  return w.panes.filter((id) => panes.has(id)).length;
}

function applyWorkspaceFilter() {
  const w = workspaces.get(activeWorkspace);
  for (const [id, entry] of panes) {
    entry.node.hidden = Boolean(w) && !w.panes.includes(id);
  }
  refreshEmpty();
}

function switchWorkspace(id) {
  if (!workspaces.has(id)) return;
  activeWorkspace = id;
  dom.wsName.textContent = workspaces.get(id).name;
  renderWorkspaces();
  applyWorkspaceFilter();
  // never leave focus on a pane the filter just hid
  if (focusedPane && workspaceOf(focusedPane) !== id) {
    const firstVisible = [...panes.keys()].find((p) => workspaceOf(p) === id);
    if (firstVisible) focusPane(firstVisible);
  }
  renderFleet(); updateVitals();
  // panes that were hidden never got a usable fit; size them now that they show
  requestAnimationFrame(fitAll);
}

// ---------------------------------------------------------------- workspaces

function renderWorkspaces() {
  dom.wsList.textContent = '';
  for (const [id, w] of workspaces) {
    const btn = document.createElement('button');
    btn.className = 'ws-item';
    btn.type = 'button';
    btn.dataset.active = String(id === activeWorkspace);
    const name = document.createElement('span');
    name.textContent = w.name;
    const count = document.createElement('span');
    count.className = 'ws-count-panes';
    count.textContent = String(w.panes.length);
    btn.dataset.attention = String(w.panes.some((id) => (panes.get(id)?.unread ?? 0) > 0));
    btn.append(name, count);
    btn.addEventListener('click', () => switchWorkspace(id));
    dom.wsList.append(btn);
  }
  dom.wsCount.textContent = `${workspaces.size} workspace${workspaces.size === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------- fleet

function paneAttention(entry) {
  return entry.unread > 0;
}

function paneActivity(entry) {
  if (!entry.pane.alive) return 'exited';
  if (entry.unread > 0) return `${entry.unread} unread`;
  if (Date.now() - entry.lastOutputAt < 2500) return 'working';
  return 'idle';
}

function renderFleet() {
  const alive = [...panes.values()];
  dom.fleet.hidden = alive.length === 0;
  dom.fleetLabel.textContent = `Fleet · ${alive.length}`;
  dom.fleetList.textContent = '';

  const sorted = alive.sort((a, b) => Number(paneAttention(b)) - Number(paneAttention(a)));
  for (const entry of sorted) {
    const attention = paneAttention(entry);
    const wsId = workspaceOf(entry.pane.id);
    const elsewhere = wsId !== null && wsId !== activeWorkspace;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'fleet-row';
    row.dataset.attention = String(attention);
    row.dataset.elsewhere = String(elsewhere);
    row.title = elsewhere
      ? `${entry.pane.id} — in ${workspaces.get(wsId)?.name ?? wsId}, jump and switch workspace`
      : `${entry.pane.id} — jump to pane`;

    const dot = document.createElement('span');
    dot.className = 'fleet-dot';
    dot.style.backgroundColor = !entry.pane.alive ? 'var(--text-muted)'
      : attention ? 'var(--danger)'
      : (Date.now() - entry.lastOutputAt < 2500) ? 'var(--accent)' : 'var(--ok)';

    const name = document.createElement('span');
    name.className = 'fleet-name';
    name.textContent = entry.pane.label;

    const act = document.createElement('span');
    act.className = 'fleet-activity';
    act.textContent = paneActivity(entry);

    // flavor chip: which CLI this row is, in that CLI's own color
    const flavorChip = document.createElement('span');
    flavorChip.className = 'fleet-flavor';
    flavorChip.textContent = entry.pane.flavor?.label ?? '';
    flavorChip.hidden = !entry.pane.flavor?.label;
    if (entry.pane.flavor?.accent) {
      flavorChip.style.color = entry.pane.flavor.accent;
      flavorChip.style.borderColor = entry.pane.flavor.accent;
    }

    // panes outside the active workspace say where they live
    if (elsewhere) {
      const tag = document.createElement('span');
      tag.className = 'fleet-ws';
      tag.textContent = workspaces.get(wsId)?.name ?? wsId;
      row.append(dot, name, flavorChip, tag, act);
    } else {
      row.append(dot, name, flavorChip, act);
    }

    const jump = document.createElement('span');
    jump.className = 'fleet-jump';
    jump.textContent = '→';
    row.append(jump);

    row.addEventListener('click', () => {
      if (elsewhere) switchWorkspace(wsId);
      focusPane(entry.pane.id);
      if (!entry.node.hidden) entry.node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    dom.fleetList.append(row);
  }
}

function updateVitals() {
  const alive = [...panes.values()].filter((e) => e.pane.alive);
  const running = alive.filter((e) => Date.now() - e.lastOutputAt < 2500).length;
  const attention = alive.filter((e) => e.unread > 0).length;
  dom.vitalRunning.hidden = running === 0;
  dom.vitalRunningN.textContent = String(running);
  dom.vitalAttention.hidden = attention === 0;
  dom.vitalAttentionN.textContent = String(attention);
}

function jumpToAttention() {
  const target = [...panes.values()].find((e) => e.unread > 0)
    || [...panes.values()].find((e) => Date.now() - e.lastOutputAt < 2500);
  if (!target) return;
  const wsId = workspaceOf(target.pane.id);
  if (wsId && wsId !== activeWorkspace) switchWorkspace(wsId);
  focusPane(target.pane.id);
  if (!target.node.hidden) target.node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

dom.vitalRunning.addEventListener('click', jumpToAttention);
dom.vitalAttention.addEventListener('click', jumpToAttention);

// ---------------------------------------------------------------- targets

function syncTargets() {
  const prev = dom.orchTarget.value;
  dom.orchTarget.textContent = '';
  const all = document.createElement('option');
  all.value = 'all'; all.textContent = 'all panes';
  dom.orchTarget.append(all);
  for (const [id, entry] of panes) {
    if (!entry.pane.alive) continue;
    const o = document.createElement('option');
    o.value = id; o.textContent = `${id} · ${entry.pane.label}`;
    dom.orchTarget.append(o);
  }
  for (const agent of collab.agents) {
    const o = document.createElement('option');
    o.value = agent.id; o.textContent = `⚙ ${agent.label || agent.provider} · ${agent.id.slice(0, 10)}`;
    dom.orchTarget.append(o);
  }
  dom.orchTarget.value = [...dom.orchTarget.options].some((o) => o.value === prev) ? prev : 'all';
  updateComposerHint();
}

function updateComposerHint() {
  const t = dom.orchTarget.value;
  if (t === 'all') {
    const alive = [...panes.values()].filter((e) => e.pane.alive).length;
    dom.composerHint.textContent = `relays to ${alive} pane(s)`;
    return;
  }
  if (collab.agents.some((a) => a.id === t)) {
    dom.composerHint.textContent = `relays to managed agent ${t} — queued durably, rides its next turn`;
    return;
  }
  // Single target: say which CLI it is and how the message will physically
  // arrive — typed into an agent's prompt, or painted into a viewport.
  const entry = panes.get(t);
  const flavor = entry?.pane.flavor;
  const who = flavor?.label && flavor.id !== 'generic' ? `${flavor.label} pane` : 'pane';
  const how = entry?.pane.deliveryMode === 'stdin'
    ? 'typed into its prompt (stdin)'
    : 'painted into its viewport (display)';
  dom.composerHint.textContent = `relays to ${t} — ${who}, ${how}`;
}

// ---------------------------------------------------------------- logs

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
    to.className = 'entry-to';
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
      chip.textContent = d.ok ? `${d.target} ${d.channel}` : `${d.target} failed: ${d.reason ?? '?'}`;
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
  // from/to are the key fields of a hive message — render them as separately
  // lit spans instead of one gray string, so the eye can trace who told whom.
  const who = document.createElement('span');
  who.className = 'entry-who';
  const from = document.createElement('span');
  from.className = 'entry-from'; from.textContent = msg.from;
  const arrow = document.createElement('span');
  arrow.className = 'entry-arrow'; arrow.textContent = '→';
  const to = document.createElement('span');
  to.className = 'entry-to'; to.textContent = msg.to;
  who.append(from, arrow, to);
  const when = document.createElement('span');
  when.textContent = time(msg.ts);
  const kind = document.createElement('span');
  kind.className = 'entry-kind';
  kind.dataset.kind = msg.kind;
  kind.textContent = msg.kind;
  head.append(who, when, kind);
  const body = document.createElement('div');
  body.className = 'entry-body';
  body.textContent = msg.text;
  node.append(head, body);
  appendTo(dom.sharedLog, node);
}

const TRACE_SKIP = new Set(['seq', 'id', 'ts', 'kind']);
/** Fields worth lighting up in a trace row: the who/where/how of an event. */
const TRACE_KEY_FIELDS = new Set([
  'from', 'to', 'target', 'paneId', 'channel', 'ok', 'held', 'kind', 'flavor', 'reason', 'label',
]);

function traceRow(event) {
  const row = document.createElement('div');
  row.className = 'trace-row';
  row.dataset.kind = event.kind;
  const when = document.createElement('span'); when.className = 'trace-time'; when.textContent = time(event.ts);
  const kind = document.createElement('span'); kind.className = 'trace-kind'; kind.textContent = event.kind;
  const detail = document.createElement('span'); detail.className = 'trace-detail';
  // One span per field, keys dim and values lit; the load-bearing fields
  // (from/to/target/channel/ok/…) glow so a scrolling trace stays skimmable.
  for (const [k, v] of Object.entries(event)) {
    if (TRACE_SKIP.has(k)) continue;
    const key = document.createElement('span');
    key.className = 'tvk';
    key.textContent = `${k}=`;
    const val = document.createElement('span');
    val.className = 'tvv';
    val.textContent = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (k === 'ok') val.classList.add(v ? 'tv-ok' : 'tv-bad');
    else if (k === 'reason') val.classList.add('tv-bad');
    else if (TRACE_KEY_FIELDS.has(k)) val.classList.add('tv-hl');
    detail.append(key, val, document.createTextNode('  '));
  }
  row.append(when, kind, detail);
  return row;
}

function traceMatches(event, needle) {
  if (!needle) return true;
  return `${event.kind} ${JSON.stringify(event)}`.toLowerCase().includes(needle.toLowerCase());
}

function pushTrace(event) {
  traceEvents.push(event);
  if (traceEvents.length > 3000) traceEvents.shift();
  appendTo(dom.traceLog, traceRow(event), 800);
  if (traceMatches(event, dom.traceFilter.value.trim())) appendTo(dom.orchTrace, traceRow(event), 800);
}

function rebuildFilteredTrace() {
  const needle = dom.traceFilter.value.trim();
  dom.orchTrace.textContent = '';
  for (const e of traceEvents.slice(-800)) if (traceMatches(e, needle)) dom.orchTrace.append(traceRow(e));
  dom.orchTrace.scrollTop = dom.orchTrace.scrollHeight;
}

function noteDelivery(delivery) {
  const entry = panes.get(delivery.target);
  if (!entry || !delivery.ok) return;
  if (delivery.channel === 'cli') entry.unread = 0;
  else if (delivery.target !== focusedPane) entry.unread += 1;
  renderUnread(entry); renderFleet(); renderWorkspaces(); updateVitals();
}

// ---------------------------------------------------------------- websocket

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.addEventListener('open', () => { reconnectDelay = 500; setStatus('connected', 'live'); });
  ws.addEventListener('message', (event) => {
    let frame; try { frame = JSON.parse(event.data); } catch { return; }
    handleFrame(frame);
  });
  ws.addEventListener('close', () => {
    setStatus(`disconnected · retry ${Math.round(reconnectDelay / 100) / 10}s`, 'down');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(8000, reconnectDelay * 2);
  });
  ws.addEventListener('error', () => setStatus('connection error', 'down'));
}

function handleFrame(frame) {
  switch (frame.type) {
    case 'hello': {
      syncPaneList(frame.panes ?? []);
      for (const m of frame.transcript ?? []) renderSharedMessage(m);
      for (const e of frame.orchestrator ?? []) renderOrchEntry(e);
      for (const e of frame.trace ?? []) pushTrace(e);
      applyCollabSnapshot(frame.collaboration);
      applyStatus(frame.status);
      break;
    }
    case 'pane.list': syncPaneList(frame.panes ?? []); break;
    case 'pane.created': mountPane(frame.pane); focusPane(frame.pane.id); break;
    case 'pane.data': {
      const entry = panes.get(frame.paneId);
      // A replay of an empty pane still matters: it sets the stream cursor.
      if (entry && (frame.data || frame.replay)) {
        if (applyStreamFrame(entry, frame)) entry.lastOutputAt = Date.now();
        if (!frame.replay) scheduleFleetRefresh();
      }
      break;
    }
    case 'pane.held': {
      const entry = panes.get(frame.paneId);
      if (entry) setHeld(entry, frame.held ?? 0);
      break;
    }
    case 'pane.exit': {
      const entry = panes.get(frame.paneId);
      if (entry) {
        entry.node.dataset.alive = 'false';
        entry.term.write(`\r\n[2m[pane exited: code ${frame.exit?.code ?? '?'}][0m\r\n`);
      }
      syncTargets(); renderFleet(); updateVitals();
      break;
    }
    case 'message': renderSharedMessage(frame.message); break;
    case 'delivery': noteDelivery(frame.delivery); break;
    case 'trace': pushTrace(frame.event); break;
    case 'orch.reply': renderOrchEntry(frame.entry); break;
    case 'agent.update': upsertCollab('agents', frame.entity); renderCollab(); syncTargets(); break;
    case 'task.update': upsertCollab('tasks', frame.entity); renderCollab(); break;
    case 'run.update': upsertCollab('runs', frame.entity); renderCollab(); break;
    case 'agent.event': pushAgentEvent(frame); break;
    case 'error': setStatus(`error: ${frame.error}`, 'down'); break;
    default: break;
  }
}

let fleetTimer = null;
function scheduleFleetRefresh() {
  if (fleetTimer) return;
  fleetTimer = setTimeout(() => { fleetTimer = null; renderFleet(); updateVitals(); }, 800);
}

function applyStatus(status) {
  if (!status) return;
  setStatus(`${status.panes?.alive ?? 0} pane(s) · ${status.traceEvents ?? 0} events`, 'live');
}

// ---------------------------------------------------------------- managed collaboration

/** Mirrors the durable server state; updated from hello + WS entity frames. */
const collab = { agents: [], runs: [], tasks: [] };

async function api(route, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function applyCollabSnapshot(snapshot) {
  if (!snapshot) return;
  collab.agents = snapshot.agents ?? [];
  collab.runs = snapshot.runs ?? [];
  collab.tasks = snapshot.tasks ?? [];
  renderCollab();
  syncTargets();
}

function upsertCollab(key, entity) {
  if (!entity || !entity.id) return;
  const i = collab[key].findIndex((x) => x.id === entity.id);
  if (i >= 0) collab[key][i] = entity;
  else collab[key].push(entity);
}

function pushAgentEvent(frame) {
  const ev = frame.event ?? {};
  const line = document.createElement('div');
  line.className = 'trace-line collab-event';
  let detail = '';
  if (ev.type === 'text') detail = String(ev.text ?? '').slice(0, 200);
  else if (ev.type === 'tool') detail = `${ev.name ?? 'tool'} ${ev.status ?? ''}`;
  else if (ev.type === 'result') detail = `result: ${ev.outcome ?? '?'} — ${String(ev.summary ?? '').slice(0, 120)}`;
  else if (ev.type === 'permission_denied') detail = `permission denied: ${ev.reason ?? ''}`;
  else if (ev.type === 'error') detail = `error: ${ev.message ?? ''}`;
  else if (ev.type === 'exit') detail = `exit ${ev.code ?? '?'}`;
  else detail = JSON.stringify(ev).slice(0, 160);
  line.textContent = `${time(Date.now())} ${frame.agentId ?? '?'} [${ev.type ?? '?'}] ${detail}`;
  appendTo(dom.collabEvents, line, 300);
}

const STATE_CLASS = {
  idle: 'ok', running: 'busy', awaiting_review: 'warn', completed: 'ok',
  failed: 'bad', cancelled: 'off', uncertain: 'bad', queued: 'off',
  active: 'ok', paused: 'warn',
};

function badge(state) {
  const span = document.createElement('span');
  span.className = `collab-badge st-${STATE_CLASS[state] ?? 'off'}`;
  span.textContent = state;
  return span;
}

function renderCollab() {
  if (!dom.collabPanel) return;
  dom.collabAgentsLabel.innerHTML = `Agents &middot; ${collab.agents.length}`;
  dom.collabRunsLabel.innerHTML = `Runs &middot; ${collab.runs.length}`;
  dom.collabTasksLabel.innerHTML = `Tasks &middot; ${collab.tasks.length}`;

  // --- agents -------------------------------------------------------------
  dom.collabAgents.textContent = '';
  for (const a of collab.agents) {
    const row = document.createElement('div');
    row.className = 'collab-row';
    const name = document.createElement('span');
    name.className = 'collab-name';
    name.textContent = `${a.label || a.provider} · ${a.id.slice(0, 12)}`;
    name.title = `${a.provider} ${a.capabilities?.version ?? ''}\n${a.cwd}`;
    row.append(name, badge(a.state));
    const perm = document.createElement('span');
    perm.className = 'collab-dim';
    perm.textContent = a.permissionProfile;
    row.append(perm);
    if (a.capabilities?.available !== true) {
      const bad = document.createElement('span');
      bad.className = 'collab-dim st-bad';
      bad.textContent = `CLI unavailable: ${a.capabilities?.reason ?? '?'}`;
      row.append(bad);
    }
    dom.collabAgents.append(row);
  }

  // --- run form agent picker ----------------------------------------------
  dom.crAgents.textContent = '';
  for (const a of collab.agents) {
    const label = document.createElement('label');
    label.className = 'collab-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = a.id;
    box.checked = collab.runs.length === 0;
    box.disabled = a.capabilities?.available !== true;
    label.append(box, document.createTextNode(` ${a.label || a.provider}`));
    dom.crAgents.append(label);
  }

  // --- runs ----------------------------------------------------------------
  dom.collabRuns.textContent = '';
  for (const r of collab.runs) {
    const row = document.createElement('div');
    row.className = 'collab-row collab-row-run';
    const name = document.createElement('span');
    name.className = 'collab-name';
    name.textContent = r.objective;
    name.title = `${r.id}\ncriteria: ${(r.acceptanceCriteria ?? []).join(' | ')}`;
    row.append(name, badge(r.state));
    const turns = document.createElement('span');
    turns.className = 'collab-dim';
    turns.textContent = `turns ${r.turnsUsed ?? 0}/${r.limits?.agentTurns ?? '?'}`;
    row.append(turns);
    const actions = document.createElement('span');
    actions.className = 'collab-actions';
    if (r.state === 'active') {
      actions.append(miniBtn('pause', () => runAction(r, 'paused')), miniBtn('cancel', () => runAction(r, 'cancelled')));
    } else if (r.state === 'paused') {
      actions.append(miniBtn('resume', () => runAction(r, 'active')));
    }
    row.append(actions);
    dom.collabRuns.append(row);
  }

  // --- pending question banner ----------------------------------------------
  const asking = collab.runs.find((r) => r.pendingQuestion);
  if (asking) {
    dom.collabQuestion.hidden = false;
    dom.collabQText.textContent = `${asking.pendingQuestion.agentId.slice(0, 12)} asks: ${asking.pendingQuestion.question}`;
    dom.collabQSend.dataset.runId = asking.id;
  } else {
    dom.collabQuestion.hidden = true;
  }

  // --- tasks -----------------------------------------------------------------
  dom.collabTasks.textContent = '';
  const order = { awaiting_review: 0, running: 1, queued: 2, uncertain: 3, failed: 4, cancelled: 5, completed: 6 };
  const sorted = [...collab.tasks].sort((x, y) => (order[x.state] ?? 9) - (order[y.state] ?? 9));
  for (const t of sorted.slice(0, 60)) {
    const row = document.createElement('div');
    row.className = 'collab-row';
    const name = document.createElement('span');
    name.className = 'collab-name';
    name.textContent = `${t.id} → ${t.assignee.slice(0, 10)}`;
    name.title = `${t.instruction}\norigin: ${t.origin}${t.result ? `\nresult: ${t.result.outcome} — ${t.result.summary}` : ''}`;
    row.append(name, badge(t.state));
    const actions = document.createElement('span');
    actions.className = 'collab-actions';
    if (t.state === 'awaiting_review') {
      actions.append(miniBtn('approve', () => reviewAction(t, true)), miniBtn('reject', () => reviewAction(t, false)));
    }
    if (t.state === 'queued' || t.state === 'running') {
      actions.append(miniBtn('cancel', () => taskAction(t, 'cancel')));
    }
    if (['failed', 'cancelled', 'uncertain'].includes(t.state)) {
      actions.append(miniBtn('retry', () => retryAction(t)));
    }
    row.append(actions);
    dom.collabTasks.append(row);
  }
}

function miniBtn(label, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tbtn tbtn-mini';
  b.textContent = label;
  b.addEventListener('click', (e) => { e.preventDefault(); fn().catch((err) => pushAgentEvent({ event: { type: 'error', message: err.message } })); });
  return b;
}

async function runAction(run, state) {
  if (state === 'cancelled' && !window.confirm(`Cancel run "${run.objective}"? Running agents are killed; queued tasks are cancelled.`)) return;
  await api(`runs/${encodeURIComponent(run.id)}/state`, {
    method: 'POST',
    body: { state, reason: 'operator action from window', expectedRevision: run.revision },
  });
}

async function reviewAction(task, approved) {
  const evidence = window.prompt(approved
    ? `Approve ${task.id}: what did YOU verify? (evidence is required)`
    : `Reject ${task.id}: why?`);
  if (!evidence || !evidence.trim()) return;
  const fresh = await api(`tasks/${encodeURIComponent(task.id)}`);
  await api(`tasks/${encodeURIComponent(task.id)}/review`, {
    method: 'POST',
    body: { approved, evidence: evidence.trim(), expectedRevision: fresh.task.revision },
  });
}

async function taskAction(task, action) {
  const fresh = await api(`tasks/${encodeURIComponent(task.id)}`);
  await api(`tasks/${encodeURIComponent(task.id)}/${action}`, {
    method: 'POST',
    body: { expectedRevision: fresh.task.revision },
  });
}

async function retryAction(task) {
  const reason = window.prompt(`Retry ${task.id}.\nConfirm: the previous process is stopped AND you reviewed its side effects.\nReason:`);
  if (!reason || !reason.trim()) return;
  const fresh = await api(`tasks/${encodeURIComponent(task.id)}`);
  await api(`tasks/${encodeURIComponent(task.id)}/retry`, {
    method: 'POST',
    body: {
      reason: reason.trim(),
      previousProcessStopped: true,
      sideEffectsReviewed: true,
      expectedRevision: fresh.task.revision,
    },
  });
}

// --- collab form wiring -----------------------------------------------------

dom.collabAgentForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    provider: dom.caProvider.value,
    permissionProfile: dom.caPermission.value,
    cwd: dom.caCwd.value.trim() || undefined,
    label: dom.caLabel.value.trim() || undefined,
  };
  try {
    const result = await api('agents', { method: 'POST', body });
    dom.caLabel.value = '';
    pushAgentEvent({ agentId: result.agent.id, event: { type: 'diagnostic', text: `agent registered (${result.agent.capabilities?.available ? 'CLI available' : `CLI UNAVAILABLE: ${result.agent.capabilities?.reason}`})` } });
  } catch (err) {
    pushAgentEvent({ event: { type: 'error', message: err.message } });
  }
});

dom.collabRunForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const objective = dom.crObjective.value.trim();
  const agentIds = [...dom.crAgents.querySelectorAll('input:checked')].map((b) => b.value);
  const criteria = dom.crCriteria.value.split(';').map((s) => s.trim()).filter(Boolean);
  if (!objective) { dom.crHint.textContent = 'objective is required'; return; }
  if (!agentIds.length) { dom.crHint.textContent = 'select at least one available agent'; return; }
  if (!dom.crPlan.checked && !criteria.length) {
    dom.crHint.textContent = 'provide acceptance criteria, or check "model plans tasks"';
    return;
  }
  dom.crHint.textContent = '';
  try {
    const result = await api('runs', {
      method: 'POST',
      body: {
        objective,
        agentIds,
        permissionProfile: dom.crPermission.value,
        ...(criteria.length ? { acceptanceCriteria: criteria } : {}),
        ...(dom.crPlan.checked ? { plan: true } : {}),
      },
    });
    dom.crObjective.value = '';
    dom.crCriteria.value = '';
    dom.crHint.textContent = dom.crPlan.checked && result.run
      ? `run ${result.run.id}: ${result.tasks.length} planned task(s)`
      : `run ${result.run.id} created — add tasks with: hive runs / hive CLI (tasks-file)`;
  } catch (err) {
    dom.crHint.textContent = `error: ${err.message}`;
  }
});

dom.collabQSend?.addEventListener('click', async () => {
  const runId = dom.collabQSend.dataset.runId;
  const text = dom.collabQInput.value.trim();
  if (!runId || !text) return;
  try {
    const fresh = await api(`runs/${encodeURIComponent(runId)}`);
    await api(`runs/${encodeURIComponent(runId)}/respond`, {
      method: 'POST',
      body: { text, expectedRevision: fresh.run.revision },
    });
    dom.collabQInput.value = '';
  } catch (err) {
    pushAgentEvent({ event: { type: 'error', message: err.message } });
  }
});
dom.collabQInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); dom.collabQSend.click(); }
});

// ---------------------------------------------------------------- palette

const COMMANDS = [
  { id: 'new-pane', label: 'New CLI pane', hint: 'display', run: () => addPane('display') },
  { id: 'new-pane-stdin', label: 'New CLI pane (stdin mode)', hint: 'stdin', run: () => addPane('stdin') },
  { id: 'toggle-orch', label: 'Toggle orchestrator', hint: 'Ctrl+J', run: () => setOrchOpen(dom.orch.dataset.open !== 'true') },
  { id: 'toggle-trace', label: 'Toggle activity trace', hint: 'Ctrl+Shift+T', run: () => setTraceOpen(dom.traceDrawer.dataset.open !== 'true') },
  { id: 'toggle-sidebar', label: 'Toggle sidebar', hint: 'Ctrl+B', run: () => toggleSidebar() },
  { id: 'new-workspace', label: 'New workspace', run: () => addWorkspace() },
  { id: 'theme-matrix', label: 'Theme: Matrix', run: () => { settings.theme = 'matrix'; saveSettings(); applySettings(); } },
  { id: 'theme-amber', label: 'Theme: Amber graphite', run: () => { settings.theme = 'amber'; saveSettings(); applySettings(); } },
  { id: 'theme-void', label: 'Theme: Void', run: () => { settings.theme = 'void'; saveSettings(); applySettings(); } },
  { id: 'theme-neon', label: 'Theme: Neon', run: () => { settings.theme = 'neon'; saveSettings(); applySettings(); } },
  { id: 'open-settings', label: 'Appearance settings', run: () => { dom.settings.hidden = false; } },
];

let paletteIndex = 0;

function paletteCommands() {
  const q = dom.paletteInput.value.trim().toLowerCase();
  const paneItems = [...panes.values()].map((e) => {
    const wsId = workspaceOf(e.pane.id);
    return {
      id: `focus-${e.pane.id}`,
      label: `Focus pane ${e.pane.id} · ${e.pane.label}`,
      hint: wsId && wsId !== activeWorkspace ? `${wsId} · ${e.pane.deliveryMode}` : e.pane.deliveryMode,
      run: () => {
        if (wsId && wsId !== activeWorkspace) switchWorkspace(wsId);
        focusPane(e.pane.id);
        if (!e.node.hidden) e.node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      },
    };
  });
  return [...COMMANDS, ...paneItems].filter((c) => !q || c.label.toLowerCase().includes(q));
}

function renderPalette() {
  const items = paletteCommands();
  paletteIndex = Math.min(paletteIndex, Math.max(0, items.length - 1));
  dom.paletteList.textContent = '';
  items.forEach((cmd, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'palette-item';
    b.dataset.active = String(i === paletteIndex);
    const label = document.createElement('span'); label.textContent = cmd.label;
    const hint = document.createElement('span'); hint.className = 'pi-hint'; hint.textContent = cmd.hint ?? '';
    b.append(label, hint);
    b.addEventListener('click', () => { closePalette(); cmd.run(); });
    b.addEventListener('mousemove', () => { paletteIndex = i; renderPaletteActive(); });
    dom.paletteList.append(b);
  });
}

function renderPaletteActive() {
  [...dom.paletteList.children].forEach((n, i) => { n.dataset.active = String(i === paletteIndex); });
}

function openPalette() {
  dom.palette.hidden = false;
  paletteIndex = 0;
  dom.paletteInput.value = '';
  renderPalette();
  dom.paletteInput.focus();
}

function closePalette() { dom.palette.hidden = true; }

dom.paletteInput.addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
dom.paletteInput.addEventListener('keydown', (e) => {
  const items = paletteCommands();
  if (e.key === 'ArrowDown') { e.preventDefault(); paletteIndex = Math.min(items.length - 1, paletteIndex + 1); renderPaletteActive(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIndex = Math.max(0, paletteIndex - 1); renderPaletteActive(); }
  else if (e.key === 'Enter') { e.preventDefault(); const cmd = items[paletteIndex]; if (cmd) { closePalette(); cmd.run(); } }
  else if (e.key === 'Escape') closePalette();
});
dom.palette.addEventListener('click', (e) => { if (e.target === dom.palette) closePalette(); });
dom.openPalette.addEventListener('click', openPalette);

// ---------------------------------------------------------------- actions

// ---------------------------------------------------------------- spawn geometry
//
// A pane spawned at the server default (80x24) and resized a moment after mount
// gives a full-screen TUI two geometries to draw with: it paints its opening
// frames for 80x24, then the PTY resizes and it repaints for the real cell
// count. On Windows ConPTY renders the TUI itself and emits absolute-positioned
// frames computed for the PTY's size, so the two sizes' frames interleave in one
// buffer and the pane's context overlaps into unreadable garbage. Measuring the
// target before spawning removes that window almost entirely.

function targetGeometry() {
  // Reuse an existing visible pane's terminal size: the grid gives every pane
  // the same cell dimensions, so this is exact when panes already exist.
  for (const entry of panes.values()) {
    if (!entry.node.hidden && entry.term.cols > 1) {
      return { cols: entry.term.cols, rows: entry.term.rows };
    }
  }
  // First pane: the grid is empty, so it fills the hero. Probe with a throwaway
  // terminal fitted to an estimated box so the child starts at the right size.
  const hero = dom.grid.getBoundingClientRect();
  if (hero.width < 160 || hero.height < 160) return {};
  const probe = document.createElement('div');
  probe.className = 'pane';
  probe.style.cssText = 'height:240px;';
  probe.innerHTML = '<div class="pane-head"></div><div class="pane-term"></div>';
  const shell = document.createElement('div');
  shell.style.cssText = `position:absolute;visibility:hidden;left:0;top:0;width:${Math.max(120, hero.width - 20)}px;`;
  shell.append(probe);
  document.body.append(shell);
  const { term, fit } = newTerminal();
  term.open(probe.querySelector('.pane-term'));
  fit.fit();
  const geo = { cols: term.cols, rows: term.rows };
  term.dispose();
  shell.remove();
  if (!(geo.cols > 1 && geo.rows > 1)) return {};
  return geo;
}

function addPane(mode) {
  const spec = { deliveryMode: mode ?? dom.newPaneMode.value, ...targetGeometry() };
  send({ type: WS_CLIENT.PANE_CREATE, spec });
}

function addWorkspace() {
  const name = `ws-${workspaces.size + 1}`;
  workspaces.set(name, { name, panes: [] });
  switchWorkspace(name);
}

function toggleSidebar() {
  const hidden = dom.sidebar.style.display === 'none';
  dom.sidebar.style.display = hidden ? '' : 'none';
  dom.sidebarRail.hidden = hidden;
  setTimeout(fitAll, 170);
}

function setOrchOpen(open) {
  dom.orch.dataset.open = String(open);
  dom.body.dataset.orch = String(open);
  dom.toggleOrch.setAttribute('aria-pressed', String(open));
  setTimeout(fitAll, 170);
  if (open) dom.orchInput.focus();
}

function setTraceOpen(open) {
  dom.traceDrawer.dataset.open = String(open);
  dom.toggleTrace.setAttribute('aria-pressed', String(open));
  setTimeout(fitAll, 170);
}

// ---------------------------------------------------------------- appearance

const SETTINGS_KEY = 'clihive.appearance';

const settings = loadSettings();

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { theme: 'amber', bgImage: null, bgOpacity: 35, bgFit: 'cover', scanlines: false, glow: true, ...JSON.parse(raw) };
  } catch { /* corrupt state falls through to defaults */ }
  return { theme: 'amber', bgImage: null, bgOpacity: 35, bgFit: 'cover', scanlines: false, glow: true };
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* image too big for quota */ }
}

function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  document.body.classList.toggle('scanlines-on', settings.scanlines);
  document.body.classList.toggle('glow-on', settings.glow);

  const bgLayer = $('bg-layer');
  if (settings.bgImage) {
    bgLayer.style.backgroundImage = `url(${settings.bgImage})`;
    document.body.classList.add('has-bg');
  } else {
    bgLayer.style.backgroundImage = '';
    document.body.classList.remove('has-bg');
  }
  // contain = whole image visible (letterboxed), good for 16:9 wallpapers
  bgLayer.style.backgroundSize = settings.bgFit === 'fill' ? '100% 100%' : settings.bgFit;
  bgLayer.style.backgroundRepeat = 'no-repeat';
  document.documentElement.style.setProperty('--bg-img-strength', String(settings.bgOpacity));

  // live-swap terminal palettes
  const theme = termTheme();
  for (const entry of panes.values()) entry.term.options.theme = theme;

  // reflect into the controls
  dom.setTheme.value = settings.theme;
  dom.setBgOpacity.value = String(settings.bgOpacity);
  dom.setBgFit.value = settings.bgFit;
  dom.setScanlines.checked = settings.scanlines;
  dom.setGlow.checked = settings.glow;
}

dom.setTheme.addEventListener('change', () => { settings.theme = dom.setTheme.value; saveSettings(); applySettings(); });
dom.setBgOpacity.addEventListener('input', () => { settings.bgOpacity = Number(dom.setBgOpacity.value); saveSettings(); applySettings(); });
dom.setBgFit.addEventListener('change', () => { settings.bgFit = dom.setBgFit.value; saveSettings(); applySettings(); });
dom.setScanlines.addEventListener('change', () => { settings.scanlines = dom.setScanlines.checked; saveSettings(); applySettings(); });
dom.setGlow.addEventListener('change', () => { settings.glow = dom.setGlow.checked; saveSettings(); applySettings(); });

dom.setBg.addEventListener('change', () => {
  const file = dom.setBg.files?.[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { setStatus('image too large (max 8 MB)', 'down'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    settings.bgImage = String(reader.result);
    saveSettings();
    applySettings();
  };
  reader.readAsDataURL(file);
});

dom.setBgClear.addEventListener('click', () => {
  settings.bgImage = null;
  dom.setBg.value = '';
  saveSettings();
  applySettings();
});

dom.openSettings.addEventListener('click', () => { dom.settings.hidden = !dom.settings.hidden; });
dom.closeSettings.addEventListener('click', () => { dom.settings.hidden = true; });
dom.settings.addEventListener('click', (e) => { if (e.target === dom.settings) dom.settings.hidden = true; });

// ---------------------------------------------------------------- wiring

dom.addPane.addEventListener('click', () => addPane());
dom.emptyAdd.addEventListener('click', () => addPane());
dom.wsAdd.addEventListener('click', addWorkspace);
dom.sidebarHide.addEventListener('click', toggleSidebar);
dom.sidebarRail.addEventListener('click', toggleSidebar);
dom.toggleOrch.addEventListener('click', () => setOrchOpen(dom.orch.dataset.open !== 'true'));
dom.closeOrch.addEventListener('click', () => setOrchOpen(false));
dom.toggleTrace.addEventListener('click', () => setTraceOpen(dom.traceDrawer.dataset.open !== 'true'));
dom.closeTrace.addEventListener('click', () => setTraceOpen(false));
dom.orchTarget.addEventListener('change', updateComposerHint);
dom.traceFilter.addEventListener('input', rebuildFilteredTrace);

for (const tab of document.querySelectorAll('.dtab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.dtab')) {
      const active = other === tab;
      other.classList.toggle('is-active', active);
      other.setAttribute('aria-selected', String(active));
    }
    for (const panel of document.querySelectorAll('.dpanel')) {
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

dom.orchForm.addEventListener('submit', (e) => { e.preventDefault(); submitOrch(); });
dom.orchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitOrch(); }
});

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key === 'k') { e.preventDefault(); dom.palette.hidden ? openPalette() : closePalette(); }
  else if (key === 'j') { e.preventDefault(); setOrchOpen(dom.orch.dataset.open !== 'true'); }
  else if (key === 'b') { e.preventDefault(); toggleSidebar(); }
  else if (key === 't' && e.shiftKey) { e.preventDefault(); setTraceOpen(dom.traceDrawer.dataset.open !== 'true'); }
});

let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitAll, 120); });
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitAll, 120); }).observe(dom.grid);
}

// working/idle dots move on a clock even when nothing else happens
setInterval(() => { renderFleet(); renderWorkspaces(); updateVitals(); }, 3000);

// Webfont swap changes cell metrics, so the geometry measured at mount can be
// stale; re-fit once fonts settle or a TUI redraws at the wrong size.
if (document.fonts?.ready) {
  document.fonts.ready.then(() => requestAnimationFrame(fitAll)).catch(() => {});
}

// Test/automation handle: the stream-integrity guards are observable, so they
// are testable. `cursor` is what proves a byte was painted exactly once.
window.__clihive = {
  panes,
  get settings() { return settings; },
  cursor: (id) => panes.get(id)?.cursor ?? 0,
  heldCount: (id) => panes.get(id)?.held ?? 0,
  /** Full text of one terminal buffer: 'active' | 'normal' | 'alternate'. */
  bufferText: (id, which = 'active') => {
    const entry = panes.get(id);
    if (!entry) return '';
    const buf = which === 'normal' ? entry.term.buffer.normal
      : which === 'alternate' ? entry.term.buffer.alternate
      : entry.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i += 1) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n');
  },
};

renderWorkspaces();
refreshEmpty();
applySettings();
connect();
