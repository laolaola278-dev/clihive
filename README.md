# clihive

A workspace multiplexer for CLI agents. One window holds many small CLI panes.
A hideable orchestrator window on the right talks to all of them at once and
coordinates their work. Every message lands on a shared transcript that any
pane can read, and every delivery is traced, so you can always answer:
*did that pane actually receive it?*

```
┌─────────────────────────── titlebar 36px ────────────────────────────┐
├──────────┬───────────────────────────────────┬───────────────────────┤
│          │  toolbar: + pane · mode · ⌘K · ⟳  │ Fleet · 3             │
│  sidebar │                                   │  ● p1 cli-1  working →│
│  240px   │   ┌─────────┐   ┌─────────┐       │  ● p2 cli-2  idle    →│
│ workspaces  │  cli-1   │   │  cli-2   │       │  ● p3 cli-3  2 unread→│
│          │   ├─────────┤   ├─────────┤       ├───────────────────────┤
│          │   │  cli-3   │   │  cli-4   │       │ Orchestrator          │
│          │   └─────────┘   └─────────┘       │ (chat|shared|trace)   │
│          │        hero terminal grid          ├───────────────────────┤
│          │                                   │ composer → all panes  │
├──────────┴───────────────────────────────────┴───────────────────────┤
│  activity trace drawer (Ctrl+Shift+T)                                │
└──────────────────────────────────────────────────────────────────────┘
```

## What it does

- **Grid of CLI panes.** Each pane is a real PTY (your shell, or an agent CLI
  like `claude` / `codex`). Panes tile; the focused pane is ringed in amber.
- **A hideable orchestrator.** The right-hand window (Ctrl/Cmd+J) addresses one
  pane or the whole hive. In manual mode it relays what you type. Point it at an
  OpenAI-compatible endpoint and a model coordinates instead.
- **Pane-to-pane talk.** Inside any pane, `hive send --to all "..."` or
  `--to p3`. Every pane sees the shared transcript, so sub-agents can follow
  each other's work.
- **A delivery trace.** Send → fanout → deliver → ack, recorded as JSONL and
  streamed to the trace views. The trace is the observability contract: it
  names the channel, the target, and whether it landed.

## The window

The layout keeps the terminals as the hero and pushes chrome to the edges:

- **Titlebar (36px).** Workspace name, live vitals (`N running`, `N need you` —
  shown only when non-zero, click to jump to the pane) and connection state.
- **Sidebar (240px).** Workspaces only. A workspace is a *view filter* over the
  hero grid: switching shows just that workspace's panes, and panes you spawn
  land in the active one. A red dot on a workspace row means a pane inside it is
  waiting on you. Collapsible with Ctrl/Cmd+B; a rail button brings it back.
- **Hero.** The pane grid. The focused pane carries a steel-blue top edge and
  glow so you can find it without reading labels. Panes tile responsively.
- **Mission-control deck (right, 326px).** Tabs across the top. The **Fleet**
  roster sits above the orchestrator thread: one row per pane with a status dot
  (amber = working, green = idle, grey = exited, red = needs you), a monospace
  activity line and a `→` jump affordance. Rows needing attention sort to the
  top. Fleet always spans **every** workspace — a pane needing input is never
  hidden by a filter; its row is tagged with its workspace and clicking it
  switches there first. Other tabs: shared transcript and the activity trace
  (filterable).
- **Command palette (Ctrl/Cmd+K).** Fuzzy search over commands and panes:
  spawn a pane, switch theme, toggle panels, jump to a pane.
- **Trace drawer (Ctrl/Cmd+Shift+T).** The full event stream along the bottom.

### Colour grammar

Two accents only, so state is legible at a glance: **amber** means alive /
action / needs attention (running dots, primary button, cursor, unread count);
**steel blue** means navigation / focus (focused pane edge, active tab, links,
focus ring). Everything else is warm graphite.

### Appearance

The ⚙ button in the titlebar (or `Appearance settings` in the palette) opens
the settings popover. Choices persist in `localStorage` and survive reloads:

| setting | options |
|---------|---------|
| **Theme** | `Amber graphite` (default warm neutral) · `Matrix` (phosphor green `#00FF41` + cyan) · `Void` (colourless near-black) · `Neon` (cyberpunk — hot magenta `#FF2E9A` + electric cyan on deep violet, gradient focus ring, pulsing primary button) |
| **Background image** | import any image up to 8 MB; stored as a data URL. Panels turn translucent so it reads through. |
| **Image fit** | `Fill` (cover, crop to window) · `Fit whole image` (letterboxed — use this for 16:9 wallpapers) · `Stretch` |
| **Image strength** | how far the image shows through the UI (0–70%) |
| **CRT scanlines** | 1px scanline overlay across the whole window |
| **Glow effects** | light bloom on running dots, the focused pane edge and (in Matrix) a slow CRT flicker; honours `prefers-reduced-motion` |

Switching theme re-paints every open terminal's palette live — no pane restart.

## Delivery: how a message actually reaches a pane

This is the part that matters, so it is explicit. A pane has one of two modes,
chosen when it is created:

| mode | what happens | when to use it |
|------|--------------|----------------|
| `display` *(default)* | The message is **painted into the pane's viewport**. The child process is never touched, so a plain shell will not try to execute the text. | shells, REPLs, anything that treats stdin as commands |
| `stdin` | The message is **written to the process's stdin**, so the program reads it as input. | agent CLIs whose stdin *is* their prompt |

Both modes also queue the message for **pull**: `hive inbox` inside the pane
returns the message and acknowledges it. That pull is the acknowledgement —
it proves an agent actually read the message, even if it was mid-turn when the
push landed.

## Run it

```bash
npm install
npm start
```

Then open the printed URL (`http://127.0.0.1:7420/?token=…`). Spawn panes with
the **+ CLI pane** button. The trace file lives at `~/.clihive/trace.jsonl`.

### The `hive` CLI (inside a pane)

Every pane is spawned with `CLIHIVE_URL`, `CLIHIVE_TOKEN`, `CLIHIVE_PANE_ID`
and `hive` on its `PATH`, so no setup is needed inside a pane:

```bash
hive whoami                      # which pane am I
hive panes                       # who else is in the window
hive send --to all "build green" # broadcast to every other pane
hive send --to p2 "take the API" # one pane
hive ask "who is free?"          # talk to the orchestrator
hive inbox                       # read + acknowledge what was sent to me
hive read                        # the shared transcript for this window
hive trace --message msg_xxx     # how a message actually travelled
hive trace --prefix msg.         # the message lifecycle, live
```

## Orchestrator

The orchestrator runs in one of two modes:

- **manual** (default): whatever you type is relayed to the addressed panes.
  Zero setup.
- **model**: set `CLIHIVE_BASE_URL`, `CLIHIVE_API_KEY`, `CLIHIVE_MODEL` before
  starting. The model sees the pane roster and shared transcript and replies
  with `{"say": "...", "actions": [{"to": "p2", "kind": "task", "text": "..."}]}`
  which are dispatched to the panes.

## Keyboard

| keys | action |
|------|--------|
| Ctrl/Cmd + K | command palette (commands + jump to pane) |
| Ctrl/Cmd + J | toggle the orchestrator window |
| Ctrl/Cmd + B | toggle the workspace sidebar |
| Ctrl/Cmd + Shift + T | toggle the activity trace drawer |
| Enter (in composer) | send |
| Shift + Enter | newline |
| Esc | close the palette / settings popover |

## HTTP API

Every route is loopback-only and needs the startup token (`Authorization: Bearer`,
`?token=`, or `x-clihive-token`). The `hive` CLI is a thin wrapper over these.

| route | method | purpose |
|-------|--------|---------|
| `/api/send` | POST | publish a message; returns `messageId` + per-target delivery receipts |
| `/api/inbox?pane=p1[&peek=1]` | GET/POST | drain (or peek) a pane's pending messages; draining emits `msg.ack` |
| `/api/transcript[?pane=p1][&limit=50]` | GET | shared transcript, whole hive or one pane |
| `/api/panes` | GET / POST | list panes / spawn one (`{command,args,cwd,deliveryMode,label}`) |
| `/api/panes/:id` | DELETE | kill a pane |
| `/api/trace[?message=][?prefix=][?limit=200]` | GET | trace events, all / one message / one kind prefix |
| `/api/delivery?message=msg_xxx` | GET | full delivery report: pushed, acked, channels, reasons |
| `/api/orchestrator[?limit=100]` | GET | orchestrator status + recent turns |
| `/api/orchestrator/ask` | POST | `{text, to}` — relay or ask the model |
| `/api/status` | GET | url, pane counts, orchestrator mode, client count, trace path |

The window itself connects over WebSocket at `/ws` and receives `hello`,
`pane.list`, `pane.created`, `pane.data`, `pane.exit`, `message`, `delivery`,
`trace` and `orch.reply` frames; it sends `pane.create`, `pane.input`,
`pane.resize`, `pane.kill`, `pane.subscribe`, `message.send` and `orch.ask`.

## Testing

```bash
npm test                    # unit tests (protocol, bus, tracer, orchestrator)
node scripts/smoke.mjs      # end-to-end with real PTYs: send, deliver, ack
node scripts/verify-ui.mjs  # drives the real window in Chromium
npm run check               # parse every source file
```

## Layout

```
src/
  shared/protocol.js   message + trace vocabulary, validation, formatting
  server/
    bus.js             shared transcript, fanout, delivery, acks
    panes.js           PTY lifecycle, scrollback, per-pane delivery
    tracer.js          append-only JSONL trace + in-memory ring
    orchestrator.js    the right-hand window: manual relay or model
    http.js            HTTP/JSON API + WebSocket + static serving
    index.js           entry point
  cli/hive.js          the command a pane uses to talk to the hive
  ui/                  the window (xterm.js, no build step)
bin/hive               shim so `hive` resolves inside a pane
```

## Security notes

- Binds to loopback only. The window authenticates with a token generated at
  startup (`~/.clihive/token`, mode 600) and handed to panes via the
  environment.
- `stdin` delivery writes to a process's input. Only use it for panes whose
  program reads stdin as a prompt; for a plain shell use the default `display`.

## License

MIT
