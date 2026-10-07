// Real-CLI acceptance run — phase 5 evidence collection.
//
//   node scripts/acceptance-real.mjs
//
// Drives the ACTUAL codex and claude CLIs on this machine through the managed
// collaboration pipeline: register agents -> create a run with two read-only
// tasks -> wait for both to reach awaiting_review -> verify their structured
// results -> operator-review with evidence -> assert the run completes and the
// work directory is untouched.
//
// Honesty rules this script enforces on itself:
//   - no fakes are injected: real adapters, real processes, real store;
//   - permission is read-only end to end; a write by an agent fails the run;
//   - any failure (auth, timeout, malformed envelope) is reported as-is and
//     exits non-zero; nothing is silently downgraded to a pass;
//   - evidence (versions, receipts, summaries, hashes, timings) is persisted
//     to .artifacts/acceptance-real-<ts>.{json,md}.
//
// Exit codes: 0 = acceptance passed; 1 = ran but failed checks;
//             2 = blocked before running (CLI unavailable).

import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { HiveServer } from '../src/server/http.js';
import { detectCli } from '../src/server/agent-runtime/adapters.js';
import { resolveCliExecutable } from '../src/server/agent-runtime/resolve-cli.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDir = path.join(root, '.artifacts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const ts = new Date().toISOString().replace(/[:.]/g, '-');

const MAGIC = '4242';
const NOTES = [
  'clihive real-CLI acceptance fixture',
  `The magic number is ${MAGIC}.`,
  'This file must not be modified by any agent (read-only permission).',
  '',
].join('\n');

const home = await mkdtemp(path.join(os.tmpdir(), 'clihive-acc-home-'));
const workdir = await mkdtemp(path.join(os.tmpdir(), 'clihive-acc-work-'));
process.env.CLIHIVE_HOME = home;
await mkdir(artifactsDir, { recursive: true });
await writeFile(path.join(workdir, 'NOTES.txt'), NOTES, 'utf8');

const log = (...args) => process.stdout.write(`${args.join(' ')}\n`);
const notesHashBefore = sha256(Buffer.from(NOTES, 'utf8'));
const workdirBefore = (await readdir(workdir)).sort();

const server = new HiveServer({
  rootDir: root,
  port: 0,
  tracePath: path.join(home, 'trace.jsonl'),
});

const evidence = {
  startedAt: new Date().toISOString(),
  machine: { platform: process.platform, node: process.version },
  workdir,
  capabilities: {},
  agents: [],
  run: null,
  tasks: [],
  receipts: [],
  agentEvents: [],
  checks: [],
  result: null,
};

let exitCode = 1;
try {
  await server.listen();
  const svc = server.collaboration;
  if (!svc) throw new Error('collaboration service failed to initialize');

  // Capture adapter events for the evidence record (bounded).
  svc.on('agent-event', ({ agentId, taskId, event }) => {
    if (evidence.agentEvents.length >= 500) return;
    evidence.agentEvents.push({
      at: new Date().toISOString(), agentId, taskId, type: event.type,
      text: typeof event.text === 'string' ? event.text.slice(0, 800) : undefined,
      tool: event.tool ?? undefined, code: event.code ?? undefined,
      message: typeof event.message === 'string' ? event.message.slice(0, 400) : undefined,
    });
    if (event.type === 'result' || event.type === 'error' || event.type === 'permission_denied') {
      log(`  [event] ${event.type} task=${taskId} ${event.message ?? ''}`.trimEnd());
    }
  });

  // --- 1. real capability probe -------------------------------------------
  log('== capability probe (real CLIs on this machine) ==');
  for (const provider of ['codex', 'claude']) {
    try {
      const executable = await resolveCliExecutable(provider);
      const detected = await detectCli(executable, { timeoutMs: 30000 });
      evidence.capabilities[provider] = { executable: executable.command, ...detected };
      log(`  ${provider}: available=${detected.available} version=${detected.version ?? '?'} cmd=${executable.command}`);
    } catch (err) {
      evidence.capabilities[provider] = { available: false, reason: String(err?.message ?? err) };
      log(`  ${provider}: UNAVAILABLE — ${err?.message ?? err}`);
    }
  }
  const blocked = Object.entries(evidence.capabilities).filter(([, c]) => c.available !== true);
  if (blocked.length > 0) {
    evidence.result = `BLOCKED: CLI unavailable or not authenticated: ${blocked.map(([p, c]) => `${p} (${c.reason ?? 'not detected'})`).join(', ')}`;
    log(`\nacceptance: BLOCKED (exit 2) — ${evidence.result}`);
    exitCode = 2;
    throw new Error('__blocked__');
  }

  // --- 2. register agents (read-only, isolated workdir) ----------------------
  log('\n== register agents ==');
  for (const provider of ['codex', 'claude']) {
    const agent = await svc.registerAgent({
      provider,
      label: `acc-${provider}`,
      cwd: workdir,
      permissionProfile: 'read-only',
    });
    evidence.agents.push({ id: agent.id, provider: agent.provider, label: agent.label, cwd: agent.cwd, permissionProfile: agent.permissionProfile });
    log(`  registered ${agent.id} (${provider}, read-only, cwd=${workdir})`);
  }
  const [codexAgent, claudeAgent] = evidence.agents;

  // --- 3. create the run ------------------------------------------------------
  const run = await svc.createRun(
    {
      objective: 'Prove the managed collaboration pipeline drives the real codex and claude CLIs end to end, read-only, with operator review.',
      agentIds: [codexAgent.id, claudeAgent.id],
      acceptanceCriteria: [
        `codex task reaches awaiting_review and its result summary contains the magic number ${MAGIC}`,
        `claude task reaches awaiting_review and its result summary contains the magic number ${MAGIC}`,
        'both receipts record permissionProfile read-only and a clean process exit',
        'NOTES.txt sha256 is unchanged and no files were created in the workdir (read-only held)',
      ],
      limits: { concurrency: 2, agentTurns: 8, taskTimeoutMs: 900000, runTimeoutMs: 2700000 },
      permissionProfile: 'read-only',
    },
    [
      {
        id: 't-codex-report',
        assignee: codexAgent.id,
        instruction: `Read the file NOTES.txt in your current working directory. Report its exact contents and state the ${MAGIC.length}-digit magic number it contains, in your structured result summary. You have read-only permission: do not attempt to modify any file.`,
        origin: 'operator',
      },
      {
        id: 't-claude-verify',
        assignee: claudeAgent.id,
        instruction: `Read the file NOTES.txt in your current working directory and report the magic number it contains in your structured result summary. You have read-only permission: do not attempt to modify any file.`,
        origin: 'operator',
      },
    ],
  );
  evidence.run = { id: run.id, state: run.state, limits: run.limits, createdAt: run.createdAt };
  log(`\n== run ${run.id} created (state=${run.state}) — waiting for both tasks ==`);

  // --- 4. wait for both tasks to reach the review gate -----------------------
  const taskIds = ['t-codex-report', 't-claude-verify'];
  const settleStates = new Set(['awaiting_review', 'completed', 'failed', 'cancelled', 'uncertain']);
  const deadline = Date.now() + 32 * 60 * 1000;
  const realIds = [];
  while (Date.now() < deadline) {
    const tasks = svc.listTasks();
    for (const t of tasks) if (!realIds.includes(t.id)) realIds.push(t.id);
    const allSettled = realIds.length >= 2 && realIds.every((id) => {
      const t = tasks.find((x) => x.id === id);
      return t && settleStates.has(t.state);
    });
    const line = realIds.map((id) => {
      const t = tasks.find((x) => x.id === id);
      return `${id.split(':').pop()}=${t?.state ?? '?'}`;
    }).join(' ');
    process.stdout.write(`\r  [${new Date().toLocaleTimeString()}] ${line}   `);
    if (allSettled) break;
    await sleep(1000);
  }
  log('');

  // --- 5. collect results and receipts ---------------------------------------
  const finalTasks = realIds.map((id) => svc.task(id));
  evidence.tasks = finalTasks.map((t) => ({
    id: t.id, state: t.state, attemptId: t.attemptId,
    resultSummary: t.result?.summary ?? null, resultOutcome: t.result?.outcome ?? null,
    error: t.error ?? null,
  }));
  evidence.receipts = realIds.flatMap((id) => svc.receiptsForTask(id)).map((r) => ({
    taskId: r.taskId, attemptId: r.id, provider: r.provider, permissionProfile: r.permissionProfile,
    outcome: r.outcome, exitCode: r.exitCode, timedOut: r.timedOut, permissionDenied: r.permissionDenied,
    sessionId: r.sessionId, startedAt: r.startedAt, endedAt: r.endedAt, error: r.error,
    deliveredMessageIds: r.deliveredMessageIds, promptChars: r.promptChars,
  }));
  for (const t of evidence.tasks) log(`  task ${t.id.split(':').pop()}: ${t.state} outcome=${t.resultOutcome ?? '-'} summary=${JSON.stringify((t.resultSummary ?? t.error ?? '').slice(0, 160))}`);
  for (const r of evidence.receipts) log(`  receipt ${r.taskId.split(':').pop()}: provider=${r.provider} perm=${r.permissionProfile} outcome=${r.outcome} exit=${r.exitCode} session=${r.sessionId ?? '-'} denied=${r.permissionDenied}`);

  // --- 6. hard checks ----------------------------------------------------------
  const notesAfter = await readFile(path.join(workdir, 'NOTES.txt'), 'utf8');
  const notesHashAfter = sha256(Buffer.from(notesAfter, 'utf8'));
  const workdirAfter = (await readdir(workdir)).sort();

  const check = (name, ok, detail) => {
    evidence.checks.push({ name, ok, detail });
    log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };
  log('\n== checks ==');
  // Task ids are used verbatim (validated kebab ids), not run-namespaced;
  // accept either shape so a future namespacing change cannot silently
  // report `state=undefined` again.
  const bySuffix = (s) => finalTasks.find((t) => t.id === s || t.id.endsWith(`:${s}`));
  const codexTask = bySuffix('t-codex-report');
  const claudeTask = bySuffix('t-claude-verify');
  check('codex task reached the review gate', codexTask?.state === 'awaiting_review', `state=${codexTask?.state}`);
  check('claude task reached the review gate', claudeTask?.state === 'awaiting_review', `state=${claudeTask?.state}`);
  check(`codex summary contains ${MAGIC}`, (codexTask?.result?.summary ?? '').includes(MAGIC));
  check(`claude summary contains ${MAGIC}`, (claudeTask?.result?.summary ?? '').includes(MAGIC));
  check('receipts record read-only permission', evidence.receipts.every((r) => r.permissionProfile === 'read-only'));
  check('no permission denials surfaced', evidence.receipts.every((r) => !r.permissionDenied));
  check('NOTES.txt sha256 unchanged', notesHashBefore === notesHashAfter, `${notesHashBefore.slice(0, 12)}… vs ${notesHashAfter.slice(0, 12)}…`);
  check('workdir has no new files', JSON.stringify(workdirBefore) === JSON.stringify(workdirAfter), `${workdirBefore.join(',')} vs ${workdirAfter.join(',')}`);

  const gatesPassed = codexTask?.state === 'awaiting_review' && claudeTask?.state === 'awaiting_review';
  if (!gatesPassed) throw new Error('tasks did not reach the review gate; skipping operator review');

  // --- 7. operator review with evidence, then run completion --------------------
  log('\n== operator review ==');
  for (const t of [codexTask, claudeTask]) {
    const fresh = svc.task(t.id);
    const reviewed = await svc.reviewTask(fresh.id, {
      approved: true,
      expectedRevision: fresh.revision,
      evidence: `Acceptance reviewer: result summary contains magic ${MAGIC} (${JSON.stringify((fresh.result?.summary ?? '').slice(0, 200))}); receipt permission read-only; NOTES.txt sha256 ${notesHashAfter.slice(0, 16)}… unchanged.`,
    });
    log(`  ${reviewed.id.split(':').pop()} -> ${reviewed.state}`);
  }
  await sleep(300);
  const finalRun = svc.run(run.id);
  evidence.run.state = finalRun.state;
  evidence.run.turnsUsed = finalRun.turnsUsed;
  evidence.run.completedAt = finalRun.updatedAt;
  check('run completed after both reviews', finalRun.state === 'completed', `state=${finalRun.state}`);

  const failed = evidence.checks.filter((c) => !c.ok);
  evidence.result = failed.length === 0 ? 'PASSED' : `FAILED: ${failed.map((f) => f.name).join('; ')}`;
  exitCode = failed.length === 0 ? 0 : 1;
} catch (err) {
  if (err.message !== '__blocked__') {
    evidence.result = `ERROR: ${err?.message ?? err}`;
    log(`\nacceptance error: ${err?.stack ?? err}`);
  }
  exitCode = exitCode === 2 ? 2 : 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  const jsonPath = path.join(artifactsDir, `acceptance-real-${ts}.json`);
  const mdPath = path.join(artifactsDir, `acceptance-real-${ts}.md`);
  await writeFile(jsonPath, JSON.stringify(evidence, null, 2), 'utf8');
  const md = [
    `# Real-CLI acceptance — ${evidence.startedAt}`,
    '',
    `Result: **${evidence.result ?? 'UNKNOWN'}**`,
    '',
    '## Environment',
    `- platform: ${evidence.machine.platform}, node ${evidence.machine.node}`,
    `- codex: ${JSON.stringify(evidence.capabilities.codex ?? null)}`,
    `- claude: ${JSON.stringify(evidence.capabilities.claude ?? null)}`,
    `- workdir: \`${evidence.workdir}\` (isolated temp, read-only run)`,
    '',
    '## Checks',
    ...evidence.checks.map((c) => `- [${c.ok ? 'x' : ' '}] ${c.name}${c.detail ? ` (${c.detail})` : ''}`),
    '',
    '## Tasks',
    ...evidence.tasks.map((t) => `- \`${t.id}\` → ${t.state}, outcome=${t.resultOutcome ?? '-'}, summary=${JSON.stringify((t.resultSummary ?? t.error ?? '').slice(0, 300))}`),
    '',
    '## Receipts',
    ...evidence.receipts.map((r) => `- \`${r.taskId}\` attempt \`${r.attemptId}\`: provider=${r.provider} perm=${r.permissionProfile} outcome=${r.outcome} exit=${r.exitCode} timedOut=${r.timedOut} denied=${r.permissionDenied} session=${r.sessionId ?? '-'} ${r.startedAt} → ${r.endedAt}`),
    '',
    `Full JSON: \`${path.basename(jsonPath)}\``,
    '',
  ].join('\n');
  await writeFile(mdPath, md, 'utf8');
  log(`\nevidence: ${mdPath}`);
  log(`evidence: ${jsonPath}`);
  await server.close().catch(() => {});
  await sleep(200);
  await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
}

log(`\nacceptance: ${evidence.result ?? 'UNKNOWN'}`);
process.exit(exitCode);
