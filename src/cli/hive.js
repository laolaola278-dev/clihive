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
  hive send [--to <pane|agent|all|orchestrator>] [--kind chat|task|result] <text...>
  hive ask <text...>                  Ask the orchestrator (right-hand window)
  hive inbox [--peek] [--json]        Read messages waiting for this pane
  hive read [--limit n] [--json]      Shared transcript for this window
  hive panes [--json]                 Pane roster
  hive trace [--message <id>] [--prefix msg.] [--limit n] [--json]
  hive status [--json]
  hive whoami

Managed agents (Codex/Claude collaboration):
  hive capabilities [--json]                     Probe codex/claude CLIs
  hive agents [--json]                           List managed agents
  hive agents add <codex|claude|opencode> [--cwd <dir>] [--permission read-only|workspace-write] [--label <name>] [--model <provider/model>]
  hive run <objective...> --agents <id,id> [--plan] [--criteria "c1;c2"]
       [--permission read-only|workspace-write] [--tasks-file <json>]
  hive runs [--json]                             List collaboration runs
  hive runs pause|resume|cancel <runId> [--reason <text>]
  hive runs respond <runId> <text...>            Answer a blocked run's question
  hive tasks [--run <runId>] [--json]            List tasks
  hive tasks show <taskId> [--json]              Task detail + receipts
  hive tasks review <taskId> --approve|--reject --evidence <text>
  hive tasks cancel <taskId>
  hive tasks retry <taskId> --reason <text> --stopped --reviewed

Options:
  --to <addr>     Target: a pane id, an agent id, "all", "orchestrator", or "human"
  --kind <kind>   chat (default), task, or result
  --from <id>     Override the sender (defaults to $CLIHIVE_PANE_ID)
  --url <url>     Hive URL (defaults to $CLIHIVE_URL, then ~/.clihive/token)
  --token <tok>   Auth token (defaults to $CLIHIVE_TOKEN, then the token file)
  --json          Machine-readable output

Notes:
  --plan asks the orchestrator model to decompose the objective into a task
  graph; without it, provide tasks via --tasks-file (JSON array of
  { id, assignee, instruction, dependencies }).
  "done" from an agent lands in awaiting_review: a human (or the auto-review
  path for message turns) must approve with evidence before dependents start.
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
    else if (arg === '--cwd') opts.cwd = argv[++i];
    else if (arg === '--permission') opts.permission = argv[++i];
    else if (arg === '--label') opts.label = argv[++i];
    else if (arg === '--model') opts.model = argv[++i];
    else if (arg === '--agents') opts.agents = argv[++i];
    else if (arg === '--plan') opts.plan = true;
    else if (arg === '--criteria') opts.criteria = argv[++i];
    else if (arg === '--tasks-file') opts.tasksFile = argv[++i];
    else if (arg === '--run') opts.run = argv[++i];
    else if (arg === '--approve') opts.approve = true;
    else if (arg === '--reject') opts.reject = true;
    else if (arg === '--evidence') opts.evidence = argv[++i];
    else if (arg === '--reason') opts.reason = argv[++i];
    else if (arg === '--stopped') opts.stopped = true;
    else if (arg === '--reviewed') opts.reviewed = true;
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
    const collab = result.collaboration;
    out(opts, result, [
      `url          ${result.url}`,
      `panes        ${result.panes.alive} alive / ${result.panes.count} total`,
      `orchestrator ${result.orchestrator.mode}${result.orchestrator.model ? ` (${result.orchestrator.model})` : ''}`,
      ...(collab ? [
        `agents       ${collab.agents.length} registered (${collab.agents.filter((a) => a.available).length} CLI available)`,
        `runs         ${collab.runs.length} total (${collab.runs.filter((r) => r.state === 'active').length} active)`,
        `tasks        ${collab.tasks.length} total (${collab.tasks.filter((t) => t.state === 'awaiting_review').length} awaiting review)`,
      ] : []),
      `clients      ${result.clients}`,
      `trace        ${result.tracePath ?? 'memory only'} (${result.traceEvents} events)`,
    ]);
  },

  async capabilities(opts) {
    const result = await api(opts, 'agents/capabilities');
    out(opts, result, Object.entries(result.capabilities).map(([name, cap]) => (cap.available
      ? `${name.padEnd(8)} available  ${cap.version ?? ''}  (${cap.executable ?? '?'})`
      : `${name.padEnd(8)} NOT available: ${cap.reason ?? 'unknown'}`)));
  },

  async agents(opts) {
    const sub = opts._[1];
    if (sub === 'add') {
      const provider = opts._[2];
      if (!provider) throw new Error('usage: hive agents add <codex|claude|opencode> [--cwd dir] [--permission p] [--label name] [--model provider/model (opencode)]');
      const body = { provider, cwd: opts.cwd ?? process.cwd() };
      if (opts.permission) body.permissionProfile = opts.permission;
      if (opts.label) body.label = opts.label;
      if (opts.model) body.model = opts.model;
      const result = await api(opts, 'agents', { method: 'POST', body });
      const a = result.agent;
      out(opts, result, [
        `registered ${a.id} (${a.provider}) ${a.capabilities?.available ? `CLI ok: ${a.capabilities.version ?? ''}` : `CLI UNAVAILABLE: ${a.capabilities?.reason ?? '?'}`}`,
        `  cwd=${a.cwd} permission=${a.permissionProfile}`,
      ]);
      return;
    }
    if (sub) throw new Error(`unknown agents subcommand: ${sub}`);
    const result = await api(opts, 'agents');
    out(opts, result, result.agents.length === 0
      ? ['no managed agents (hive agents add codex|claude|opencode)']
      : result.agents.map((a) => [
        `${a.id.padEnd(24)} ${a.provider.padEnd(9)} ${a.state.padEnd(8)} ${a.permissionProfile.padEnd(15)} ${a.label ?? ''}`,
        ...(a.capabilities?.available ? [] : [`    CLI unavailable: ${a.capabilities?.reason ?? '?'}`]),
      ].join('\n')));
  },

  async run(opts) {
    const objective = opts._.slice(1).join(' ').trim();
    if (!objective) throw new Error('usage: hive run <objective...> --agents <id,id> [--plan | --tasks-file f.json] [--criteria "c1;c2"]');
    const agentIds = (opts.agents ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!agentIds.length) throw new Error('--agents <id,id> is required (see: hive agents)');
    const body = { objective, agentIds };
    if (opts.permission) body.permissionProfile = opts.permission;
    if (opts.criteria) body.acceptanceCriteria = opts.criteria.split(';').map((s) => s.trim()).filter(Boolean);
    if (opts.plan) body.plan = true;
    if (opts.tasksFile) body.tasks = JSON.parse(await readFile(opts.tasksFile, 'utf8'));
    if (!body.plan && !Array.isArray(body.tasks)) {
      throw new Error('provide --plan (model decomposes the objective) or --tasks-file <json>');
    }
    const result = await api(opts, 'runs', { method: 'POST', body });
    out(opts, result, [
      `run ${result.run.id} [${result.run.state}] ${objective}`,
      `  agents: ${result.run.agentIds.join(', ')}`,
      `  criteria: ${result.run.acceptanceCriteria.join(' | ')}`,
      ...result.tasks.map((t) => `  task ${t.id.padEnd(20)} -> ${t.assignee} [${t.state}]${t.dependencies.length ? ` after ${t.dependencies.join(',')}` : ''}`),
    ]);
  },

  async runs(opts) {
    const sub = opts._[1];
    if (['pause', 'resume', 'cancel'].includes(sub)) {
      const runId = opts._[2];
      if (!runId) throw new Error(`usage: hive runs ${sub} <runId> [--reason text]`);
      const current = await api(opts, `runs/${encodeURIComponent(runId)}`);
      const state = sub === 'pause' ? 'paused' : sub === 'resume' ? 'active' : 'cancelled';
      const result = await api(opts, `runs/${encodeURIComponent(runId)}/state`, {
        method: 'POST',
        body: { state, reason: opts.reason ?? null, expectedRevision: current.run.revision },
      });
      out(opts, result, [`run ${runId} -> ${result.run.state}${result.run.reason ? ` (${result.run.reason})` : ''}`]);
      return;
    }
    if (sub === 'respond') {
      const runId = opts._[2];
      const text = opts._.slice(3).join(' ').trim();
      if (!runId || !text) throw new Error('usage: hive runs respond <runId> <text...>');
      const current = await api(opts, `runs/${encodeURIComponent(runId)}`);
      if (!current.run.pendingQuestion) throw new Error('run has no pending question');
      process.stdout.write(`question from ${current.run.pendingQuestion.agentId}: ${current.run.pendingQuestion.question}\n`);
      const result = await api(opts, `runs/${encodeURIComponent(runId)}/respond`, {
        method: 'POST',
        body: { text, expectedRevision: current.run.revision },
      });
      out(opts, result, [`answer delivered to ${current.run.pendingQuestion.agentId}`]);
      return;
    }
    if (sub) throw new Error(`unknown runs subcommand: ${sub}`);
    const result = await api(opts, 'runs');
    out(opts, result, result.runs.length === 0
      ? ['no runs']
      : result.runs.map((r) => {
        const counts = r.tasks.reduce((acc, t) => { acc[t.state] = (acc[t.state] ?? 0) + 1; return acc; }, {});
        const summary = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ');
        return [
          `${r.id} [${r.state}] turns ${r.turnsUsed}/${r.limits.agentTurns}  ${r.objective}`,
          `  tasks: ${summary || '(none)'}`,
          ...(r.pendingQuestion ? [`  QUESTION from ${r.pendingQuestion.agentId}: ${r.pendingQuestion.question}`] : []),
          ...(r.reason ? [`  reason: ${r.reason}`] : []),
        ].join('\n');
      }));
  },

  async tasks(opts) {
    const sub = opts._[1];
    if (sub === 'show') {
      const taskId = opts._[2];
      if (!taskId) throw new Error('usage: hive tasks show <taskId>');
      const result = await api(opts, `tasks/${encodeURIComponent(taskId)}`);
      const t = result.task;
      out(opts, result, [
        `task ${t.id} [${t.state}] run=${t.runId} assignee=${t.assignee} origin=${t.origin}`,
        `  instruction: ${t.instruction}`,
        ...(t.result ? [`  result: ${t.result.outcome} — ${t.result.summary}`] : []),
        ...(t.verification ? [`  verification: ${t.verification.status} by ${t.verification.source} — ${t.verification.evidence ?? ''}`] : []),
        ...(t.error ? [`  error: ${t.error}`] : []),
        ...result.receipts.map((r) => `  receipt ${r.attemptId}: ${r.outcome}${r.timedOut ? ' (timed out)' : ''}${r.permissionDenied ? ' (permission denied)' : ''}`),
      ]);
      return;
    }
    if (sub === 'review') {
      const taskId = opts._[2];
      if (!taskId || (!opts.approve && !opts.reject)) throw new Error('usage: hive tasks review <taskId> --approve|--reject --evidence <text>');
      if (!opts.evidence) throw new Error('--evidence <text> is required: what did YOU verify?');
      const current = await api(opts, `tasks/${encodeURIComponent(taskId)}`);
      const result = await api(opts, `tasks/${encodeURIComponent(taskId)}/review`, {
        method: 'POST',
        body: { approved: Boolean(opts.approve), evidence: opts.evidence, expectedRevision: current.task.revision },
      });
      out(opts, result, [`task ${taskId} -> ${result.task.state}`]);
      return;
    }
    if (sub === 'cancel') {
      const taskId = opts._[2];
      if (!taskId) throw new Error('usage: hive tasks cancel <taskId>');
      const current = await api(opts, `tasks/${encodeURIComponent(taskId)}`);
      const result = await api(opts, `tasks/${encodeURIComponent(taskId)}/cancel`, {
        method: 'POST',
        body: { expectedRevision: current.task.revision },
      });
      out(opts, result, [`task ${taskId}: ${result.task.state}${result.task.cancelRequested ? ' (cancel requested; confirms when the process stops)' : ''}`]);
      return;
    }
    if (sub === 'retry') {
      const taskId = opts._[2];
      if (!taskId) throw new Error('usage: hive tasks retry <taskId> --reason <text> --stopped --reviewed');
      if (!opts.reason) throw new Error('--reason <text> is required');
      if (!opts.stopped || !opts.reviewed) {
        throw new Error('retry requires explicit confirmation flags: --stopped (previous process is gone) --reviewed (side effects inspected)');
      }
      const current = await api(opts, `tasks/${encodeURIComponent(taskId)}`);
      const result = await api(opts, `tasks/${encodeURIComponent(taskId)}/retry`, {
        method: 'POST',
        body: {
          reason: opts.reason,
          previousProcessStopped: true,
          sideEffectsReviewed: true,
          expectedRevision: current.task.revision,
        },
      });
      out(opts, result, [`task ${taskId} -> ${result.task.state} (retry queued)`]);
      return;
    }
    if (sub && sub !== 'list') throw new Error(`unknown tasks subcommand: ${sub}`);
    const query = opts.run ? `tasks?run=${encodeURIComponent(opts.run)}` : 'tasks';
    const result = await api(opts, query);
    out(opts, result, result.tasks.length === 0
      ? ['no tasks']
      : result.tasks.map((t) => `${t.id.padEnd(22)} ${t.state.padEnd(15)} ${t.assignee.padEnd(24)} ${t.origin.padEnd(9)} ${t.instruction.slice(0, 60)}`));
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
