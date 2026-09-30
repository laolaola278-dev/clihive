#!/usr/bin/env node
// `hive` -- the CLI a pane uses to talk to the rest of the window.
//
// Every pane is spawned with CLIHIVE_PANE_ID, CLIHIVE_URL and CLIHIVE_TOKEN in
// its environment, so inside a pane these commands need no configuration:
//
//   hive send --to all "build is green"
//   hive send --to p2 "take the API tests"
//   hive ask "who is free?"          # talk to the orchestrator
//   hive inbox                       # read + acknowledge what was sent to me
//   hive read                        # the shared transcript for this window
//   hive panes                       # who else is in the window
//   hive trace --message msg_xxx     # how a message actually travelled

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  ADDRESS_ALL,
  ADDRESS_HUMAN,
  MESSAGE_KINDS,
} from '../shared/protocol.js';

const HELP = `hive -- talk to the other CLI panes in this window

Usage:
  hive send [--to <pane|all|orchestrator>] [--kind chat|task|result] <text...>
  hive ask <text...>                  Ask the orchestrator (right-hand window)
  hive inbox [--peek] [--json]        Read messages waiting for this pane
  hive read [--limit n] [--json]      Shared transcript for this window
  hive panes [--json]                 Pane roster
  hive trace [--message <id>] [--prefix msg.] [--limit n] [--json]
  hive status [--json]
  hive whoami

Options:
  --to <addr>     Target: a pane id, "all", "orchestrator", or "human"
  --kind <kind>   chat (default), task, or result
  --from <id>     Override the sender (defaults to $CLIHIVE_PANE_ID)
  --url <url>     Hive URL (defaults to $CLIHIVE_URL, then ~/.clihive/token)
  --token <tok>   Auth token (defaults to $CLIHIVE_TOKEN, then the token file)
  --json          Machine-readable output
`;

function parse(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--to') opts.to = argv[++i];
    else if (arg === '--kind') opts.kind = argv[++i];
    else if (arg === '--from') opts.from = argv[++i];
    else if (arg === '--url') opts.url = argv[++i];
    else if (arg === '--token') opts.token = argv[++i];
    else if (arg === '--message' || arg === '-m') opts.message = argv[++i];
    else if (arg === '--prefix') opts.prefix = argv[++i];
    else if (arg === '--limit' || arg === '-n') opts.limit = Number(argv[++i]);
    else if (arg === '--peek') opts.peek = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else opts._.push(arg);
  }
  return opts;
}

async function resolveEndpoint(opts) {
  let url = opts.url || process.env.CLIHIVE_URL || '';
  let token = opts.token || process.env.CLIHIVE_TOKEN || '';

  if (!url || !token) {
    const home = process.env.CLIHIVE_HOME || path.join(os.homedir(), '.clihive');
    try {
      const raw = await readFile(path.join(home, 'token'), 'utf8');
      const parsed = JSON.parse(raw);
      url = url || parsed.url;
      token = token || parsed.token;
    } catch {
      // Fall through to the error below.
    }
  }

  if (!url || !token) {
    throw new Error(
      'no hive endpoint found. Run the hive, or pass --url and --token.',
    );
  }
  return { url: url.replace(/\/+$/, ''), token };
}

async function api(opts, route, { method = 'GET', body } = {}) {
  const { url, token } = await resolveEndpoint(opts);
  const res = await fetch(`${url}/api/${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`hive returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(json.error ? `${json.error}` : `HTTP ${res.status}`);
  }
  return json;
}

function selfId(opts) {
  return opts.from || process.env.CLIHIVE_PANE_ID || ADDRESS_HUMAN;
}

function out(opts, json, lines) {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
  } else {
    process.stdout.write(`${lines.join('\n')}\n`);
  }
}

function stamp(ts) {
  return new Date(ts).toLocaleTimeString();
}

const commands = {
  async send(opts) {
    const text = opts._.slice(1).join(' ').trim();
    if (!text) throw new Error('nothing to send');
    const result = await api(opts, 'send', {
      method: 'POST',
      body: {
        from: selfId(opts),
        to: opts.to || ADDRESS_ALL,
        kind: opts.kind || MESSAGE_KINDS.CHAT,
        text,
      },
    });
    const ok = result.targets.filter((t) => t.ok);
    const bad = result.targets.filter((t) => !t.ok);
    out(opts, result, [
      `sent ${result.messageId}`,
      `  delivered: ${ok.length ? ok.map((t) => t.target).join(', ') : '(nobody)'}`,
      ...(bad.length ? [`  failed:    ${bad.map((t) => `${t.target} (${t.reason})`).join(', ')}`] : []),
    ]);
  },

  async ask(opts) {
    const text = opts._.slice(1).join(' ').trim();
    if (!text) throw new Error('nothing to ask');
    const result = await api(opts, 'orchestrator/ask', {
      method: 'POST',
      body: { text, to: opts.to },
    });
    out(opts, result, [
      `orchestrator (${result.mode}): ${result.say}`,
      ...result.actions.map((a) => `  -> ${a.to}: ${String(a.text).slice(0, 120)}`),
    ]);
  },

  async inbox(opts) {
    const me = selfId(opts);
    const query = `inbox?pane=${encodeURIComponent(me)}${opts.peek ? '&peek=1' : ''}`;
    const result = await api(opts, query, { method: opts.peek ? 'GET' : 'POST' });
    out(opts, result, result.count === 0
      ? [`inbox empty for ${me}`]
      : [
        `${result.count} message(s) for ${me}${opts.peek ? ' (peek, not acknowledged)' : ''}`,
        ...result.messages.map((m) => `  [${stamp(m.ts)}] ${m.from} -> ${m.to} (${m.kind}) ${m.text}`),
      ]);
  },

  async read(opts) {
    const me = selfId(opts);
    const limit = Number.isFinite(opts.limit) ? opts.limit : 30;
    const result = await api(opts, `transcript?pane=${encodeURIComponent(me)}&limit=${limit}`);
    out(opts, result, result.count === 0
      ? ['transcript empty']
      : result.messages.map((m) => `[${stamp(m.ts)}] ${m.from} -> ${m.to} (${m.kind}) ${m.text}`));
  },

  async panes(opts) {
    const result = await api(opts, 'panes');
    out(opts, result, result.panes.length === 0
      ? ['no panes']
      : result.panes.map((p) => {
        const state = p.alive ? 'alive' : `exited(${p.exit?.code ?? '?'})`;
        const self = p.id === selfId(opts) ? '  <- you' : '';
        return `${p.id.padEnd(8)} ${p.label.padEnd(16)} ${state.padEnd(12)} pid=${p.pid ?? '-'}${self}`;
      }));
  },

  async trace(opts) {
    const params = new URLSearchParams();
    if (opts.message) params.set('message', opts.message);
    if (opts.prefix) params.set('prefix', opts.prefix);
    params.set('limit', String(Number.isFinite(opts.limit) ? opts.limit : 50));
    const result = await api(opts, `trace?${params}`);
    out(opts, result, result.count === 0
      ? ['no trace events']
      : result.events.map((e) => {
        const bits = Object.entries(e)
          .filter(([k]) => !['seq', 'id', 'ts', 'kind'].includes(k))
          .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
          .join(' ');
        return `[${stamp(e.ts)}] #${String(e.seq).padStart(4)} ${e.kind.padEnd(14)} ${bits}`;
      }));
  },

  async status(opts) {
    const result = await api(opts, 'status');
    out(opts, result, [
      `url          ${result.url}`,
      `panes        ${result.panes.alive} alive / ${result.panes.count} total`,
      `orchestrator ${result.orchestrator.mode}${result.orchestrator.model ? ` (${result.orchestrator.model})` : ''}`,
      `clients      ${result.clients}`,
      `trace        ${result.tracePath ?? 'memory only'} (${result.traceEvents} events)`,
    ]);
  },

  async whoami(opts) {
    const info = {
      paneId: process.env.CLIHIVE_PANE_ID ?? null,
      label: process.env.CLIHIVE_PANE_LABEL ?? null,
      url: process.env.CLIHIVE_URL ?? null,
      inHive: Boolean(process.env.CLIHIVE_PANE_ID),
    };
    out(opts, info, [
      info.inHive
        ? `pane ${info.paneId} ("${info.label}") in hive ${info.url}`
        : 'not running inside a hive pane',
    ]);
  },
};

const opts = parse(process.argv.slice(2));
const command = opts._[0];

if (opts.help || !command) {
  process.stdout.write(HELP);
  process.exit(command ? 0 : 1);
}

const handler = commands[command];
if (!handler) {
  process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
  process.exit(1);
}

try {
  await handler(opts);
} catch (err) {
  process.stderr.write(`hive: ${err?.message ?? err}\n`);
  process.exit(1);
}
