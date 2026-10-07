// End-to-end smoke test against a real hive with real PTYs.
//
//   node scripts/smoke.mjs
//
// Covers the load-bearing claims:
//   - a pane can talk to every other pane with `hive send`
//   - a display-mode pane shows the message without its shell executing it
//   - a stdin-mode pane's *program* reads the message as process input
//     (a real stdin reader, not a shell that would execute the text)
//   - the shared transcript is visible to peers
//   - the trace records send -> fanout -> deliver -> ack
//   - the orchestrator can address the whole hive

import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { HiveServer } from '../src/server/http.js';
import { stripAnsi } from '../src/shared/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = await mkdtemp(path.join(os.tmpdir(), 'clihive-smoke-'));
process.env.CLIHIVE_HOME = home;

const server = new HiveServer({
  rootDir: root,
  port: 0,
  tracePath: path.join(home, 'trace.jsonl'),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Scrollback with ANSI and *all* whitespace removed.
 *
 * A terminal hard-wraps at the column limit and inserts a real CRLF mid-token,
 * so `"smoke1790"` + `"752920605"` is how a marker actually lands on screen.
 * Collapsing whitespace is not enough; it has to go entirely.
 */
function dense(paneId) {
  return stripAnsi(server.panes.scrollback(paneId)).replace(/\s+/g, '');
}

/** Same normalisation for the needle. */
function needle(text) {
  return text.replace(/\s+/g, '');
}

/** Does this pane's viewport contain `text`, ignoring wrapping? */
function shows(paneId, text) {
  return dense(paneId).includes(needle(text));
}

/** Readable form, for failure messages and the "did it run?" check. */
function flat(paneId) {
  return stripAnsi(server.panes.scrollback(paneId)).replace(/\s+/g, ' ');
}

async function waitFor(fn, label, timeout = 25000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

let failed = false;
function check(cond, label) {
  process.stdout.write(`${cond ? 'PASS' : 'FAIL'}  ${label}\n`);
  if (!cond) failed = true;
}

const nl = process.platform === 'win32' ? '\r' : '\n';

try {
  const { url } = await server.listen();
  process.stdout.write(`hive at ${url}\n\n`);

  const a = await server.createPane({ label: 'alpha' });
  const b = await server.createPane({ label: 'beta' });
  // A stdin-mode pane must run a program that READS stdin — a shell would try
  // to execute the notification text as a command, which proves nothing about
  // stdin delivery. This reader echoes every line with a marker we can assert.
  const c = await server.createPane({
    label: 'agentish',
    deliveryMode: 'stdin',
    command: process.execPath,
    args: ['-e', "process.stdout.write('READER-UP\\n');process.stdin.on('data',(d)=>{for(const l of String(d).split(/\\r?\\n/)){if(l.trim())process.stdout.write('STDIN-RECEIVED: '+l+'\\n')}})"],
  });
  await sleep(1800);
  await waitFor(() => shows(c.id, 'READER-UP'), 'stdin reader process started and its output was captured');

  check(a.deliveryMode === 'display', 'panes default to display delivery');
  check(c.deliveryMode === 'stdin', 'stdin delivery is opt-in per pane');

  // --- pane -> all --------------------------------------------------------
  const marker = `smoke${Date.now()}`;
  server.panes.write(a.id, `hive send --to all "hello from alpha ${marker}"${nl}`);

  const sent = await waitFor(
    () => server.bus.fullTranscript().find((m) => m.text.includes(marker)),
    'message on the shared transcript',
  );
  check(sent.from === a.id, `sender resolved from pane env (${sent.from})`);

  await waitFor(() => shows(b.id, marker), 'message visible in beta');
  check(true, 'display-mode pane shows the message');

  // The decisive check for display mode: the shell must not have run the text.
  await sleep(600);
  const betaText = flat(b.id);
  check(!/is not recognized|不是内部或外部命令|command not found/.test(betaText),
    'display-mode pane did not execute the message as a command');

  let cReached = false;
  try {
    await waitFor(() => { cReached = shows(c.id, marker); return cReached; }, 'message reached the stdin-mode pane', 8000);
  } catch (err) {
    // Dump the pane's real state so a failure is diagnosable, then fail.
    process.stdout.write(`DEBUG c record: ${JSON.stringify(server.panes.list().find((p) => p.id === c.id))}\n`);
    process.stdout.write(`DEBUG c scrollback: ${JSON.stringify(stripAnsi(server.panes.scrollback(c.id)).slice(0, 300))}\n`);
    process.stdout.write(`DEBUG delivery: ${JSON.stringify(server.bus.deliveryReport(sent.id).targets)}\n`);
    throw err;
  }
  // The decisive stdin check: the child program itself must have read the line
  // and echoed it back with its marker — the text went through the process,
  // not just onto a screen.
  await waitFor(() => shows(c.id, 'STDIN-RECEIVED'), 'stdin-mode child program read and echoed the message');
  check(true, 'stdin-mode pane received the message as process input');

  const report = server.bus.deliveryReport(sent.id);
  const byTarget = new Map(report.targets.map((t) => [t.target, t]));
  check(byTarget.get(b.id)?.pushed === true, 'delivery report: pushed to beta');
  check(byTarget.get(c.id)?.pushed === true, 'delivery report: pushed to the stdin pane');
  check(!byTarget.has(a.id), 'sender excluded from its own broadcast');

  const channels = report.records.filter((r) => r.ok).map((r) => r.channel);
  check(channels.includes('display') && channels.includes('pty'),
    `both channels recorded: ${[...new Set(channels)].join(', ')}`);

  const kinds = server.tracer.forMessage(sent.id).map((e) => e.kind);
  check(kinds.includes('msg.send') && kinds.includes('msg.fanout') && kinds.includes('msg.deliver'),
    `trace chain: ${[...new Set(kinds)].join(' -> ')}`);

  // --- peers see each other's chatter -------------------------------------
  check(server.bus.transcriptFor(b.id).some((m) => m.id === sent.id),
    'beta sees the message on its shared transcript');
  check(server.bus.transcriptFor(c.id).some((m) => m.id === sent.id),
    'the third pane sees it too');

  // --- pull track / acknowledgement --------------------------------------
  check(server.bus.pendingCount(b.id) === 1, 'message is queued for pull in beta');
  server.panes.write(b.id, `hive inbox${nl}`);
  await waitFor(() => server.tracer.forMessage(sent.id).some((e) => e.kind === 'msg.ack'),
    'ack from hive inbox');
  check(server.bus.deliveryReport(sent.id).targets.find((t) => t.target === b.id)?.acked === true,
    'beta acknowledged the message via hive inbox');
  check(server.bus.pendingCount(b.id) === 0, 'pull queue drained after ack');

  // --- direct pane -> pane ------------------------------------------------
  const dm = `direct${Date.now()}`;
  server.panes.write(a.id, `hive send --to ${b.id} "psst ${dm}"${nl}`);
  const dmMsg = await waitFor(
    () => server.bus.fullTranscript().find((m) => m.text.includes(dm)),
    'direct message published',
  );
  await waitFor(() => shows(b.id, dm), 'direct message in beta');
  check(!shows(c.id, dm), 'direct message was not pushed to the third pane');
  check(server.bus.deliveryReport(dmMsg.id).targets.length === 1, 'direct message had exactly one target');

  // --- orchestrator -------------------------------------------------------
  const orch = await server.orchestrator.ask({ text: `standup ${marker}`, to: 'all' });
  check(orch.mode === 'manual', 'orchestrator runs in manual mode without an API key');
  await waitFor(
    () => shows(a.id, `standup ${marker}`)
      && shows(b.id, `standup ${marker}`)
      && shows(c.id, `standup ${marker}`),
    'orchestrator broadcast in every pane',
  );
  // The stdin pane must show the reader's echo too (it consumed the broadcast).
  const cText = flat(c.id);
  check((cText.match(/STDIN-RECEIVED/g) ?? []).length >= 2,
    'stdin reader echoed every message it was sent');
  check(!/is not recognized|不是内部或外部命令|command not found/.test(cText),
    'stdin-mode pane never executed a message as a shell command');
  check(true, 'orchestrator reached all three panes');

  // --- trace persistence --------------------------------------------------
  const onDisk = await server.tracer.readFileEvents();
  check(onDisk.some((e) => e.messageId === sent.id && e.kind === 'msg.deliver'),
    `trace persisted to JSONL (${onDisk.length} events)`);
} catch (err) {
  failed = true;
  process.stdout.write(`FAIL  ${err.message}\n`);
} finally {
  await server.close();
  await sleep(400);
  await rm(home, { recursive: true, force: true }).catch(() => {});
}

process.stdout.write(failed ? '\nsmoke: FAILED\n' : '\nsmoke: OK\n');
process.exit(failed ? 1 : 0);
