// Real-CLI acceptance for the opencode managed adapter (opencode 1.18.x).
//
//   node scripts/acceptance-opencode.mjs [provider/model]
//
// Separate from acceptance-real.mjs (codex+claude) because opencode needs an
// explicit working model: its default free tier is rejected on many machines.
// Model resolution: argv[2] -> CLIHIVE_OPENCODE_MODEL -> BLOCKED (exit 2).
//
// What a PASS proves, with the real opencode process and no fakes:
//   1. read task: structured JSON result parsed, summary contains the fixture
//      number, session id captured, task stops at awaiting_review;
//   2. write-attempt task (read-only profile): the agent is told to create a
//      file; the file must NOT exist afterwards (permission boundary held);
//   3. operator review -> completed, run completed;
//   4. fixture sha256 unchanged and no new files in the workdir.
// Exit: 0 pass / 1 failed checks / 2 blocked (CLI missing or no model).

import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { HiveServer } from '../src/server/http.js';
import { detectCli } from '../src/server/agent-runtime/adapters.js';
import { resolveCliExecutable } from '../src/server/agent-runtime/resolve-cli.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDir = path.join(root, '.artifacts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const log = (...a) => process.stdout.write(`${a.join(' ')}\n`);

const MAGIC = '4242';
const NOTES = `clihive opencode acceptance fixture\nThe magic number is ${MAGIC}.\nRead-only: never modify this file.\n`;
const model = process.argv[2] || process.env.CLIHIVE_OPENCODE_MODEL || null;

const home = await mkdtemp(path.join(os.tmpdir(), 'clihive-occ-home-'));
const workdir = await mkdtemp(path.join(os.tmpdir(), 'clihive-occ-work-'));
process.env.CLIHIVE_HOME = home;
await mkdir(artifactsDir, { recursive: true });
await writeFile(path.join(workdir, 'NOTES.txt'), NOTES, 'utf8');
const hashBefore = sha256(NOTES);
const filesBefore = (await readdir(workdir)).sort();

const evidence = { startedAt: new Date().toISOString(), model, workdir, capabilities: null, tasks: [], receipts: [], agentEvents: [], checks: [], result: null };
const server = new HiveServer({ rootDir: root, port: 0, tracePath: path.join(home, 'trace.jsonl') });
let exitCode = 1;

async function persist() {
  evidence.finishedAt = new Date().toISOString();
  const base = path.join(artifactsDir, `acceptance-opencode-${ts}`);
  await writeFile(`${base}.json`, JSON.stringify(evidence, null, 2), 'utf8');
  const md = [
    `# opencode real acceptance — ${evidence.startedAt}`, '',
    `- result: **${evidence.result}**`, `- model: ${model}`,
    `- capabilities: ${JSON.stringify(evidence.capabilities)}`, '', '## checks',
    ...evidence.checks.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`), '',
    '## receipts', ...evidence.receipts.map((r) => `- ${r.taskId}: ${r.provider} ${r.permissionProfile} outcome=${r.outcome} exit=${r.exitCode} session=${r.sessionId} denied=${r.permissionDenied}`),
  ].join('\n');
  await writeFile(`${base}.md`, md, 'utf8');
  log(`evidence: ${base}.md`);
}

try {
  await server.listen();
  const svc = server.collaboration;
  svc.on('agent-event', ({ taskId, event }) => {
    if (evidence.agentEvents.length < 400) evidence.agentEvents.push({ at: new Date().toISOString(), taskId, type: event.type, name: event.name, status: event.status, message: event.message?.slice?.(0, 300), text: event.text?.slice?.(0, 300) });
  });

  log('== capability probe ==');
  let executable;
  try {
    executable = await resolveCliExecutable('opencode');
    evidence.capabilities = { executable: executable.command, ...(await detectCli(executable, { timeoutMs: 30000 })) };
  } catch (err) {
    evidence.capabilities = { available: false, reason: String(err?.message ?? err) };
  }
  log(`  opencode: ${JSON.stringify(evidence.capabilities)}`);
  if (!evidence.capabilities.available || !model) {
    evidence.result = `BLOCKED: ${!evidence.capabilities.available ? 'opencode unavailable' : 'no model (pass provider/model or set CLIHIVE_OPENCODE_MODEL)'}`;
    log(`acceptance: ${evidence.result}`);
    exitCode = 2;
    throw new Error('__blocked__');
  }

  const agent = await svc.registerAgent({ provider: 'opencode', label: 'acc-opencode', cwd: workdir, permissionProfile: 'read-only', model });
  const run = await svc.createRun({
    objective: 'Prove the opencode managed adapter works end to end with the real CLI, read-only.',
    agentIds: [agent.id],
    acceptanceCriteria: [`read task summary contains ${MAGIC}`, 'write attempt leaves no file behind', 'both tasks stop at awaiting_review'],
    limits: { concurrency: 1, agentTurns: 8, taskTimeoutMs: 600000, runTimeoutMs: 1800000 },
    permissionProfile: 'read-only',
  }, [
    { id: 't-oc-read', assignee: agent.id, origin: 'operator', instruction: `Read NOTES.txt in your working directory and report the magic number it contains in your result summary. You have read-only permission.` },
    { id: 't-oc-write', assignee: agent.id, origin: 'operator', instruction: 'Use your file-writing tool to create a file named INTRUDER.txt containing the word pwned, then run the shell command `echo hi > INTRUDER2.txt`. If either is refused or impossible, do not retry or work around it: report outcome "blocked" with a question saying what was refused.' },
  ]);
  log(`== run ${run.id} ==`);

  const settle = new Set(['awaiting_review', 'completed', 'failed', 'cancelled', 'uncertain']);
  const deadline = Date.now() + 25 * 60 * 1000;
  let ids = [];
  while (Date.now() < deadline) {
    const tasks = svc.listTasks();
    ids = tasks.map((t) => t.id);
    process.stdout.write(`\r  ${tasks.map((t) => `${t.id}=${t.state}`).join(' ')}   `);
    if (tasks.length >= 2 && tasks.every((t) => settle.has(t.state))) break;
    // A failed/cancelled/uncertain task strands its dependents in `queued`
    // forever; stop waiting instead of burning the whole deadline.
    const dead = tasks.some((t) => ['failed', 'cancelled', 'uncertain'].includes(t.state));
    const busy = tasks.some((t) => t.state === 'running');
    if (dead && !busy) { log('\n  a task ended failed/cancelled/uncertain; dependents cannot run — stopping the wait'); break; }
    await sleep(1000);
  }
  log('');

  const tasks = ids.map((id) => svc.task(id));
  evidence.tasks = tasks.map((t) => ({ id: t.id, state: t.state, outcome: t.result?.outcome ?? null, summary: t.result?.summary ?? null, question: t.result?.question ?? null, error: t.error ?? null }));
  evidence.receipts = ids.flatMap((id) => svc.receiptsForTask(id)).map((r) => ({ taskId: r.taskId, provider: r.provider, permissionProfile: r.permissionProfile, outcome: r.outcome, exitCode: r.exitCode, timedOut: r.timedOut, permissionDenied: r.permissionDenied, sessionId: r.sessionId, error: r.error }));
  for (const t of evidence.tasks) log(`  task ${t.id}: ${t.state} outcome=${t.outcome} summary=${JSON.stringify((t.summary ?? t.error ?? '').slice(0, 140))}`);
  for (const r of evidence.receipts) log(`  receipt ${r.taskId}: perm=${r.permissionProfile} outcome=${r.outcome} exit=${r.exitCode} session=${r.sessionId} denied=${r.permissionDenied}`);

  const check = (name, ok, detail) => { evidence.checks.push({ name, ok, detail }); log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
  const read = tasks.find((t) => t.id === 't-oc-read');
  const write = tasks.find((t) => t.id === 't-oc-write');
  const after = (await readdir(workdir)).sort();
  log('\n== checks ==');
  check('read task reached the review gate', read?.state === 'awaiting_review', `state=${read?.state}`);
  check(`read summary contains ${MAGIC}`, (read?.result?.summary ?? '').includes(MAGIC));
  check('read receipt has a real session id and exit 0', evidence.receipts.some((r) => r.taskId === 't-oc-read' && r.sessionId && r.exitCode === 0));
  check('write-attempt task settled as designed: blocked + question surfaced to the operator (or awaiting_review)',
    (write?.state === 'failed' && write?.result?.outcome === 'blocked' && Boolean(write?.result?.question) && Boolean(svc.run(run.id).pendingQuestion))
      || write?.state === 'awaiting_review',
    `state=${write?.state} outcome=${write?.result?.outcome} question=${JSON.stringify((write?.result?.question ?? '').slice(0, 100))}`);
  // Honesty: whether the model even TRIED a write tool decides what this run proves.
  const writeToolCalls = evidence.agentEvents.filter((e) => e.taskId === 't-oc-write' && e.type === 'tool' && /^(write|edit|bash|patch)$/i.test(e.name ?? ''));
  evidence.writeToolAttempts = writeToolCalls.length;
  log(`  INFO  write-tool attempts by the model: ${writeToolCalls.length}${writeToolCalls.length ? '' : ' — it refused from the prompt alone, so this run does NOT prove CLI-level enforcement'}`);
  check('INTRUDER.txt / INTRUDER2.txt do NOT exist (boundary held)', !after.includes('INTRUDER.txt') && !after.includes('INTRUDER2.txt'), `files=${after.join(',')}`);
  check('NOTES.txt unchanged', sha256(await readFile(path.join(workdir, 'NOTES.txt'), 'utf8')) === hashBefore);
  check('no new files in workdir', JSON.stringify(after) === JSON.stringify(filesBefore));
  check('all receipts read-only', evidence.receipts.length >= 2 && evidence.receipts.every((r) => r.permissionProfile === 'read-only'));

  if (read?.state === 'awaiting_review') {
    await svc.reviewTask(read.id, { approved: true, expectedRevision: svc.task(read.id).revision, evidence: `operator reviewed real opencode result for ${read.id}: ${(read.result?.summary ?? '').slice(0, 200)}` });
    check('read task completed after operator review', svc.task(read.id).state === 'completed', `state=${svc.task(read.id).state}`);
  }

  const failed = evidence.checks.filter((c) => !c.ok);
  evidence.result = failed.length ? `FAILED: ${failed.map((c) => c.name).join('; ')}` : 'PASSED';
  exitCode = failed.length ? 1 : 0;
  log(`\nacceptance: ${evidence.result}`);
} catch (err) {
  if (err.message !== '__blocked__') {
    evidence.result = `ERROR: ${err.message}`;
    log(`acceptance error: ${err.stack ?? err}`);
    exitCode = 1;
  }
} finally {
  await persist().catch((e) => log(`persist failed: ${e.message}`));
  await server.close?.().catch?.(() => {});
  process.exit(exitCode);
}
