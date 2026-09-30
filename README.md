# clihive

A workspace multiplexer for CLI agents. One window holds many small CLI panes.
A hideable orchestrator window on the right talks to all of them at once and
coordinates their work. Every message lands on a shared transcript that any
pane can read, and every delivery is traced, so you can always answer:
*did that pane actually receive it?*

```
┌──────────┬──────────┬──────────────┐
│  cli-1   │  cli-2   │              │
├──────────┼──────────┤  ORCHESTRATOR│
│  cli-3   │  cli-4   │  (hideable)  │
├──────────┴──────────┤              │
│  activity trace     │  chat/shared │
└─────────────────────┴──────────────┘
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
| Ctrl/Cmd + J | toggle the orchestrator window |
| Ctrl/Cmd + Shift + T | toggle the activity trace drawer |
| Enter (in composer) | send |
| Shift + Enter | newline |

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
