// End-to-end probe for the plugin system against a REAL HiveServer process.
// Verifies: plugin install via HTTP → live injection into a dispatched turn's
// prompt → history injection on the second task → continueRun bridging.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { HiveServer } from '../src/server/http.js';

const doneResult = {
  summary: 'probe result', outcome: 'done', artifacts: [], checks: [],
  messages: [], followUps: [], question: null,
};

const home = await mkdtemp(path.join(tmpdir(), 'clihive-e2e-'));
const turns = [];
const server = new HiveServer({
  rootDir: process.cwd(),
  port: 0,
  writeToken: false,
  tracePath: path.join(home, 'trace.jsonl'),
  collabDir: path.join(home, 'collab'),
  pluginsDir: path.join(home, 'plugins'),
  collaboration: {
    resolveExecutable: async (name) => ({ command: `fake-${name}`, prependArgs: [], resolvedFrom: 'test' }),
    detect: async () => ({ available: true, version: 'fake-1.0' }),
    runTurnImpl: (_adapter, options) => new Promise((resolve) => {
      turns.push({ prompt: options.prompt, resolve });
      if (options.onSpawn) options.onSpawn({ pid: 4242, exitCode: null, kill: () => {} });
    }),
    killTree: () => {},
  },
});
const { url, token } = await server.listen();
const api = async (route, { method = 'GET', body } = {}) => {
  const res = await fetch(`${url}/api/${route}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const pass = (name) => console.log(`PASS  ${name}`);
const fail = (name, detail) => { console.error(`FAIL  ${name} — ${detail}`); process.exitCode = 1; };

try {
  // 1. Install a plugin with a skill + history.
  const add = await api('plugins', { method: 'POST', body: {
    name: 'e2e-kit', version: '1.0.0',
    description: 'e2e probe plugin',
    skills: [{ name: 'triage', prompt: 'E2E-TRIAGE-SKILL-7f3k' }],
    historyTurns: 5,
  } });
  if (add.status !== 201) fail('plugin install', JSON.stringify(add.json)); else pass('plugin install via POST /api/plugins');

  // 2. Register an agent and run a first task.
  const agentRes = await api('agents', { method: 'POST', body: { provider: 'codex', cwd: home, label: 'E2E' } });
  if (agentRes.status !== 201) fail('agent register', JSON.stringify(agentRes.json));
  const agentId = agentRes.json.agent.id;
  pass(`agent registered: ${agentId}`);

  const run1 = await api('runs', { method: 'POST', body: {
    objective: 'first pass', agentIds: [agentId], acceptanceCriteria: ['it works'],
    tasks: [{ id: 't-1', assignee: agentId, instruction: 'E2E-FIRST-TASK', dependencies: [] }],
  } });
  if (run1.status !== 201) fail('run create', JSON.stringify(run1.json)); else pass('run 1 created');

  await new Promise((r) => setTimeout(r, 150));
  const first = turns[0];
  if (!first) fail('turn dispatch', 'first turn never dispatched');
  else if (!first.prompt.includes('E2E-TRIAGE-SKILL-7f3k')) fail('skill injection', 'skill text missing from real prompt');
  else pass('skill injected into the real dispatched prompt');
  first?.resolve({ ok: true, sessionId: 's-e2e', rawResult: doneResult, error: null, exitCode: 0, timedOut: false, spawnError: null, stderrTail: '', attemptId: 'a1' });

  await new Promise((r) => setTimeout(r, 200));
  const t1 = (await api('tasks/t-1')).json.task;
  const review = await api('tasks/t-1/review', { method: 'POST', body: { approved: true, evidence: 'e2e', expectedRevision: t1.revision } });
  if (review.status !== 200) fail('review', JSON.stringify(review.json)); else pass('task reviewed');

  // 3. Second task on the same agent: history must now appear.
  const run2 = await api('runs', { method: 'POST', body: {
    objective: 'second pass', agentIds: [agentId], acceptanceCriteria: ['it works'],
    tasks: [{ id: 't-2', assignee: agentId, instruction: 'E2E-SECOND-TASK', dependencies: [] }],
  } });
  if (run2.status !== 201) fail('run 2 create', JSON.stringify(run2.json));
  await new Promise((r) => setTimeout(r, 150));
  const second = turns[1];
  if (!second) fail('turn 2 dispatch', 'second turn never dispatched');
  else if (!second.prompt.includes('E2E-SECOND-TASK')) fail('turn 2', 'second task missing');
  else if (!second.prompt.includes('probe result')) fail('history injection', 'first result summary missing from prompt');
  else if (!second.prompt.includes('Your own recent history in this hive')) fail('history section', 'history section header missing');
  else pass('local history injected into the second turn');
  second?.resolve({ ok: true, sessionId: 's-e2e2', rawResult: doneResult, error: null, exitCode: 0, timedOut: false, spawnError: null, stderrTail: '', attemptId: 'a2' });
  await new Promise((r) => setTimeout(r, 150));
  const t2 = (await api('tasks/t-2')).json.task;
  await api('tasks/t-2/review', { method: 'POST', body: { approved: true, evidence: 'e2e', expectedRevision: t2.revision } });

  // 4. continueRun: bridge the first run into a new one.
  const fromRunId = run1.json.run.id;
  const cont = await api(`runs/${fromRunId}/continue`, { method: 'POST', body: {
    objective: 'continue development', agentIds: [agentId], acceptanceCriteria: ['still works'],
    tasks: [{ id: 't-3', assignee: agentId, instruction: 'E2E-CONTINUED-TASK', dependencies: [] }],
  } });
  if (cont.status !== 201) fail('continueRun', JSON.stringify(cont.json));
  else if (cont.json.continuedFrom !== fromRunId) fail('continueRun', 'continuedFrom mismatch');
  else pass('continueRun created a new run bridged to the old one');

  await new Promise((r) => setTimeout(r, 150));
  const third = turns[2];
  if (!third) fail('turn 3 dispatch', 'continued turn never dispatched');
  else if (!third.prompt.includes('E2E-CONTINUED-TASK')) fail('turn 3', 'continued task missing');
  else if (!third.prompt.includes('Prior work this run continues')) fail('prior-work bridge', 'bridge section missing');
  else pass('continueRun bridge injected prior results into the new turn');
  third?.resolve({ ok: true, sessionId: 's-e2e3', rawResult: doneResult, error: null, exitCode: 0, timedOut: false, spawnError: null, stderrTail: '', attemptId: 'a3' });
  await new Promise((r) => setTimeout(r, 150));

  // 5. Plugin removal is live.
  const del = await api('plugins/e2e-kit', { method: 'DELETE' });
  if (del.status !== 200) fail('plugin remove', JSON.stringify(del.json)); else pass('plugin removed, set is live');

  console.log(process.exitCode ? '\nE2E: FAILED' : '\nE2E: all checks passed');
} finally {
  await server.close();
  await new Promise((r) => setTimeout(r, 60));
  await rm(home, { recursive: true, force: true });
}
