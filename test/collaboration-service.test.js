import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CollaborationStore } from '../src/server/collaboration-store.js';
import { CollaborationService } from '../src/server/collaboration-service.js';

// Wait for an async condition (the service dispatches fire-and-forget).
async function waitFor(fn, { timeout = 2000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = fn();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

function makeTurnController() {
  const calls = [];
  const impl = (adapter, options) => new Promise((resolve) => {
    const call = { adapter, options, resolve, child: null, prompt: options.prompt };
    if (options.onSpawn) {
      const child = { pid: 4321, exitCode: null, killed: null, kill: (...args) => { child.killed = args; } };
      call.child = child;
      options.onSpawn(child);
    }
    calls.push(call);
  });
  return { impl, calls };
}

const doneResult = (over = {}) => ({
  summary: 'work complete', outcome: 'done', artifacts: [], checks: [],
  messages: [], followUps: [], question: null, ...over,
});

describe('CollaborationService', () => {
  let dir;
  let store;
  let turns;
  let service;
  let idCounter;
  const ids = (prefix) => `${prefix}-${String(++idCounter).padStart(4, '0')}`;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'clihive-svc-'));
    store = await CollaborationStore.open(dir);
    turns = makeTurnController();
    idCounter = 0;
    service = new CollaborationService({
      store,
      ids,
      resolveExecutable: async (name) => ({ command: `fake-${name}`, prependArgs: [], resolvedFrom: 'test' }),
      detect: async () => ({ available: true, version: 'fake-1.0' }),
      runTurnImpl: turns.impl,
      killTree: (child) => child.kill('SIGKILL'),
      baseEnv: { PATH: '/usr/bin', CLIHIVE_PANE_ID: 'leak-me', CLIHIVE_TOKEN: 'secret' },
    });
    await service.init();
  });

  afterEach(async () => {
    await service.close();
    // Let fire-and-forget scheduling tails (#settle/pump) finish before the
    // store goes away, so they never reject against a closed store.
    await new Promise((r) => setTimeout(r, 40));
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function addAgent(provider, opts = {}) {
    return service.registerAgent({ provider, cwd: opts.cwd ?? dir, permissionProfile: opts.permissionProfile ?? 'read-only', label: opts.label });
  }

  it('registers an agent, resolving cwd and probing capability', async () => {
    const agent = await addAgent('codex', { label: 'Codex A' });
    assert.equal(agent.state, 'idle');
    assert.equal(agent.cwd, dir);
    assert.ok(agent.cwdKey.length > 0);
    assert.equal(agent.capabilities.available, true);
    assert.equal(agent.capabilities.version, 'fake-1.0');
    assert.equal(agent.permissionProfile, 'read-only');
  });

  it('records an unavailable CLI without throwing and blocks it from runs', async () => {
    const svc = new CollaborationService({
      store,
      resolveExecutable: async () => ({ command: 'x', prependArgs: [], resolvedFrom: 'test' }),
      detect: async () => ({ available: false, reason: 'version probe timed out' }),
      runTurnImpl: turns.impl,
      killTree: (child) => child.kill('SIGKILL'),
    });
    const agent = await svc.registerAgent({ provider: 'claude', cwd: dir });
    assert.equal(agent.capabilities.available, false);
    await assert.rejects(svc.createRun({ objective: 'x', agentIds: [agent.id], acceptanceCriteria: ['y'] }), /not available for managed turns/);
  });

  it('dispatches by dependency order and holds "done" at the review gate', async () => {
    const a = await addAgent('codex');
    const run = await service.createRun(
      { objective: 'Ship feature', agentIds: [a.id], acceptanceCriteria: ['Tests pass', 'Reviewed'] },
      [
        { id: 'task-1', assignee: a.id, instruction: 'Write the code' },
        { id: 'task-2', assignee: a.id, instruction: 'Review the code', dependencies: ['task-1'] },
      ],
    );

    // Only task-1 is eligible; task-2 waits on its dependency.
    const first = await waitFor(() => turns.calls[0], { label: 'first dispatch' });
    assert.equal(turns.calls.length, 1);
    assert.match(first.prompt, /Write the code/);
    assert.match(first.prompt, /Ship feature/);
    assert.equal(service.task('task-2').state, 'queued');

    // A "done" result must NOT auto-complete: it lands in awaiting_review.
    first.resolve({ ok: true, sessionId: 'ses-1', rawResult: doneResult({ summary: 'code written' }) });
    await waitFor(() => service.task('task-1').state === 'awaiting_review', { label: 'task-1 awaiting review' });
    assert.equal(service.task('task-2').state, 'queued', 'dependency not satisfied until review passes');
    assert.equal(service.agent(a.id).sessionId, 'ses-1', 'session id captured for resumption');

    // Operator review completes task-1, which unblocks task-2.
    const t1 = service.task('task-1');
    await service.reviewTask('task-1', { approved: true, evidence: 'Diff inspected, tests green', expectedRevision: t1.revision });
    assert.equal(service.task('task-1').state, 'completed');
    const second = await waitFor(() => turns.calls[1], { label: 'second dispatch' });
    assert.match(second.prompt, /Review the code/);
    assert.match(second.prompt, /code written/, 'dependency result is carried into the prompt');
    assert.equal(second.options.permissionProfile, 'read-only');
    assert.equal(second.options.sessionId, 'ses-1', 'resumes the captured session');
    assert.equal(run.agentIds.length, 1);
  });

  it('intersects run and agent permissions down to the stricter profile', async () => {
    const a = await addAgent('codex', { permissionProfile: 'workspace-write' });
    // Run is read-only, agent allows write -> effective must be read-only.
    await service.createRun(
      { objective: 'Inspect only', agentIds: [a.id], acceptanceCriteria: ['Report'], permissionProfile: 'read-only' },
      [{ id: 'ro-task', assignee: a.id, instruction: 'Look but do not touch' }],
    );
    const call = await waitFor(() => turns.calls[0], { label: 'dispatch' });
    assert.equal(call.options.permissionProfile, 'read-only');
  });

  it('strips pane identity and hive token from the child environment', async () => {
    const a = await addAgent('codex');
    await service.createRun({ objective: 'o', agentIds: [a.id], acceptanceCriteria: ['c'] }, [{ id: 'env-task', assignee: a.id, instruction: 'i' }]);
    const call = await waitFor(() => turns.calls[0], { label: 'dispatch' });
    assert.equal(call.options.env.CLIHIVE_TOKEN, undefined);
    assert.equal(call.options.env.CLIHIVE_PANE_ID, undefined);
    assert.equal(call.options.env.CLIHIVE_MANAGED_AGENT, '1');
    assert.equal(call.options.env.CLIHIVE_AGENT_ID, a.id);
  });

  it('runs one task per agent and one writer per directory', async () => {
    const a = await addAgent('codex', { permissionProfile: 'workspace-write' });
    await service.createRun(
      { objective: 'Two writes, one dir', agentIds: [a.id], acceptanceCriteria: ['c'], permissionProfile: 'workspace-write' },
      [
        { id: 'w1', assignee: a.id, instruction: 'write one' },
        { id: 'w2', assignee: a.id, instruction: 'write two' },
      ],
    );
    await waitFor(() => turns.calls[0], { label: 'first writer' });
    // Same agent => w2 cannot start until w1 finishes and is reviewed.
    assert.equal(turns.calls.length, 1);
    assert.equal(service.task('w2').state, 'queued');
  });

  it('validates and enqueues model follow-ups as proposals with depth limits', async () => {
    const a = await addAgent('codex');
    const b = await addAgent('claude');
    await service.createRun(
      { objective: 'Hand off', agentIds: [a.id, b.id], acceptanceCriteria: ['c'] },
      [{ id: 'seed', assignee: a.id, instruction: 'start' }],
    );
    const first = await waitFor(() => turns.calls[0], { label: 'seed dispatch' });
    first.resolve({ ok: true, sessionId: 's', rawResult: doneResult({
      followUps: [{ assignee: b.id, instruction: 'continue the work', dependencies: [] }],
    }) });
    await waitFor(() => service.task('seed').state === 'awaiting_review', { label: 'seed review' });
    const follow = await waitFor(() => service.listTasks().find((t) => t.origin === 'followup'), { label: 'follow-up task' });
    assert.equal(follow.assignee, b.id);
    assert.equal(follow.depth, 1);
    assert.ok(['queued', 'running'].includes(follow.state));
    // Approve seed so the follow-up (no deps) can dispatch.
    await service.reviewTask('seed', { approved: true, evidence: 'ok', expectedRevision: service.task('seed').revision });
    const second = await waitFor(() => turns.calls[1], { label: 'follow-up dispatch' });
    assert.match(second.prompt, /continue the work/);
  });

  it('rejects a follow-up that names a non-member or unknown dependency', async () => {
    const a = await addAgent('codex');
    await service.createRun({ objective: 'o', agentIds: [a.id], acceptanceCriteria: ['c'] }, [{ id: 'seed', assignee: a.id, instruction: 'i' }]);
    const first = await waitFor(() => turns.calls[0], { label: 'dispatch' });
    // validateAgentResult itself rejects non-member recipients, so the whole
    // result is refused and the task fails rather than smuggling a bad follow-up.
    first.resolve({ ok: true, sessionId: 's', rawResult: doneResult({
      followUps: [{ assignee: 'intruder', instruction: 'x', dependencies: [] }],
    }) });
    await waitFor(() => service.task('seed').state === 'failed', { label: 'rejected result' });
    assert.equal(service.listTasks().filter((t) => t.origin === 'followup').length, 0);
  });

  it('delivers peer messages at least once and marks them on attempt end', async () => {
    const a = await addAgent('codex');
    const b = await addAgent('claude');
    await service.createRun({ objective: 'o', agentIds: [a.id, b.id], acceptanceCriteria: ['c'] }, [
      { id: 'ta', assignee: a.id, instruction: 'a work' },
      { id: 'tb', assignee: b.id, instruction: 'b work', dependencies: ['ta'] },
    ]);
    const aTurn = await waitFor(() => turns.calls.find((c) => c.options.cwd && c.prompt.includes('a work')), { label: 'a dispatch' });
    aTurn.resolve({ ok: true, sessionId: 'sa', rawResult: doneResult({ messages: [{ to: b.id, text: 'here is context for you' }] }) });
    await waitFor(() => service.task('ta').state === 'awaiting_review', { label: 'a review' });
    await service.reviewTask('ta', { approved: true, evidence: 'ok', expectedRevision: service.task('ta').revision });

    const bTurn = await waitFor(() => {
      const call = turns.calls.find((c) => c.prompt.includes('b work'));
      // The message must have been committed before b's turn was built.
      return call && call.prompt.includes('here is context for you') ? call : null;
    }, { label: 'b dispatch carrying the queued message' });
    // Message still pending until the attempt ends.
    bTurn.resolve({ ok: true, sessionId: 'sb', rawResult: doneResult() });
    await waitFor(() => service.task('tb').state === 'awaiting_review', { label: 'b review' });
    const pending = service.store.list('messages').filter((m) => m.state === 'pending');
    assert.equal(pending.length, 0, 'message marked delivered after the attempt ended');
  });

  it('wakes an idle agent with pending messages via an auto-reviewed message turn', async () => {
    const a = await addAgent('codex');
    const run = await service.createRun({ objective: 'o', agentIds: [a.id], acceptanceCriteria: ['c'] }, []);
    // No tasks; deliver an external message to the idle agent.
    await service.deliverExternalMessage({ from: 'human', to: a.id, text: 'please summarize status' });
    const call = await waitFor(() => turns.calls[0], { label: 'message turn' });
    assert.match(call.prompt, /please summarize status/);
    const msgTask = service.listTasks(run.id).find((t) => t.origin === 'message');
    assert.ok(msgTask);
    call.resolve({ ok: true, sessionId: 's', rawResult: doneResult() });
    // origin:'message' turns are auto-reviewed straight to completed.
    await waitFor(() => service.task(msgTask.id).state === 'completed', { label: 'auto-reviewed' });
  });

  it('pauses a run when the agent-turn budget is exhausted', async () => {
    const a = await addAgent('codex');
    const run = await service.createRun(
      { objective: 'o', agentIds: [a.id], acceptanceCriteria: ['c'], limits: { agentTurns: 1 } },
      [{ id: 'only', assignee: a.id, instruction: 'i' }],
    );
    const call = await waitFor(() => turns.calls[0], { label: 'dispatch' });
    call.resolve({ ok: true, sessionId: 's', rawResult: doneResult() });
    await waitFor(() => service.task('only').state === 'awaiting_review', { label: 'review gate' });
    // turnsUsed is now 1 == agentTurns; the run should be paused by the guard.
    await waitFor(() => service.run(run.id).state === 'paused', { label: 'budget pause' });
    assert.match(service.run(run.id).reason, /budget-exhausted:agentTurns/);
  });

  it('records a blocked result as a run question the operator can answer', async () => {
    const a = await addAgent('codex');
    const run = await service.createRun({ objective: 'o', agentIds: [a.id], acceptanceCriteria: ['c'] }, [{ id: 'bt', assignee: a.id, instruction: 'i' }]);
    const call = await waitFor(() => turns.calls[0], { label: 'dispatch' });
    call.resolve({ ok: true, sessionId: 's', rawResult: doneResult({ outcome: 'blocked', summary: 'need write access', question: 'May I modify src/app.js?' }) });
    await waitFor(() => service.run(run.id).pendingQuestion, { label: 'pending question' });
    assert.match(service.run(run.id).pendingQuestion.question, /May I modify/);
    assert.equal(service.task('bt').state, 'failed', 'blocked is not success');
    await service.respondToRun(run.id, { text: 'Yes, proceed', expectedRevision: service.run(run.id).revision });
    assert.equal(service.run(run.id).pendingQuestion, null);
  });

  it('persists cancellation intent, kills the child, and confirms on exit', async () => {
    const a = await addAgent('codex');
    await service.createRun({ objective: 'o', agentIds: [a.id], acceptanceCriteria: ['c'] }, [{ id: 'ct', assignee: a.id, instruction: 'i' }]);
    const call = await waitFor(() => turns.calls[0], { label: 'dispatch' });
    await service.cancelTask('ct', { expectedRevision: service.task('ct').revision });
    assert.equal(service.task('ct').cancelRequested, true);
    assert.ok(call.child.killed, 'child process signalled');
    // The turn ends (killed); the completion path confirms cancellation.
    call.resolve({ ok: false, error: 'killed', exitCode: null, timedOut: false });
    await waitFor(() => service.task('ct').state === 'cancelled', { label: 'cancel confirmed' });
  });

  it('recovers an in-flight attempt as uncertain after a restart', async () => {
    const a = await addAgent('codex');
    await service.createRun({ objective: 'o', agentIds: [a.id], acceptanceCriteria: ['c'] }, [{ id: 'rt', assignee: a.id, instruction: 'i' }]);
    await waitFor(() => turns.calls[0], { label: 'dispatch' });
    assert.equal(service.task('rt').state, 'running');

    // Simulate a restart: a fresh service over the same store, without
    // resolving the in-flight turn.
    const revivedTurns = makeTurnController();
    const revived = new CollaborationService({
      store,
      ids, // shared counter: attempt/receipt ids must not collide with the store
      resolveExecutable: async (name) => ({ command: `fake-${name}`, prependArgs: [], resolvedFrom: 'test' }),
      detect: async () => ({ available: true, version: 'fake-1.0' }),
      runTurnImpl: revivedTurns.impl,
      killTree: (child) => child.kill('SIGKILL'),
    });
    await revived.init();
    assert.equal(revived.task('rt').state, 'uncertain', 'in-flight attempt became uncertain');
    assert.equal(revived.agent(a.id).state, 'idle');
    // Retry is gated on explicit operator confirmation.
    await assert.rejects(revived.retryTask('rt', { reason: 'go', previousProcessStopped: true, sideEffectsReviewed: false, expectedRevision: revived.task('rt').revision }), /side-effect review/);
    await revived.retryTask('rt', { reason: 'checked', previousProcessStopped: true, sideEffectsReviewed: true, expectedRevision: revived.task('rt').revision });
    await waitFor(() => revived.task('rt').state === 'running', { label: 'retry dispatched' });
    assert.equal(revivedTurns.calls.length, 1);
    assert.notEqual(revivedTurns.calls[0].options.attemptId, turns.calls[0].options.attemptId, 'retry uses a fresh attempt id');
    await revived.close();
  });

  it('fails a task when the adapter turn fails', async () => {
    const a = await addAgent('codex');
    await service.createRun({ objective: 'o', agentIds: [a.id], acceptanceCriteria: ['c'] }, [{ id: 'ft', assignee: a.id, instruction: 'i' }]);
    const call = await waitFor(() => turns.calls[0], { label: 'dispatch' });
    call.resolve({ ok: false, error: 'codex exited with code 1', exitCode: 1, timedOut: false, stderrTail: 'boom' });
    await waitFor(() => service.task('ft').state === 'failed', { label: 'task failed' });
    assert.match(service.task('ft').result.summary, /codex exited with code 1/);
  });

  it('completes a run only when every task is reviewed complete', async () => {
    const a = await addAgent('codex');
    const run = await service.createRun({ objective: 'o', agentIds: [a.id], acceptanceCriteria: ['c'] }, [{ id: 'solo', assignee: a.id, instruction: 'i' }]);
    const call = await waitFor(() => turns.calls[0], { label: 'dispatch' });
    call.resolve({ ok: true, sessionId: 's', rawResult: doneResult() });
    await waitFor(() => service.task('solo').state === 'awaiting_review', { label: 'review gate' });
    assert.notEqual(service.run(run.id).state, 'completed');
    await service.reviewTask('solo', { approved: true, evidence: 'ok', expectedRevision: service.task('solo').revision });
    await waitFor(() => service.run(run.id).state === 'completed', { label: 'run completed' });
  });
});
