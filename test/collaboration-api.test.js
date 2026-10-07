// Server-level integration test for the managed-collaboration HTTP API.
//
// Real HiveServer, real durable store (temp dir), real orchestrator planner —
// but the agent CLIs and the planner model endpoint are faked, so this proves
// the wiring, not real Codex/Claude behavior (that is the separate acceptance
// gate).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HiveServer } from '../src/server/http.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function waitFor(fn, { timeout = 8000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

function makeTurnController() {
  const calls = [];
  const impl = (adapter, options) => new Promise((resolve) => {
    const call = { adapter, options, resolve, child: null, prompt: options.prompt };
    if (options.onSpawn) {
      const child = { pid: 999, exitCode: null, killed: null, kill: (...args) => { child.killed = args; } };
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

describe('collaboration HTTP API', () => {
  let home;
  let work;
  let server;
  let url;
  let token;
  let turns;
  let fetchCalls;

  const api = async (route, { method = 'GET', body, useToken = token } = {}) => {
    const res = await fetch(`${url}/api/${route}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(useToken ? { authorization: `Bearer ${useToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  before(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'clihive-api-'));
    work = await mkdtemp(path.join(tmpdir(), 'clihive-api-work-'));
    turns = makeTurnController();
    fetchCalls = [];

    // Fake planner endpoint: builds a two-task graph around whichever agent
    // ids the orchestrator embedded in its prompt.
    const fakeFetch = async (endpoint, init) => {
      const body = JSON.parse(init.body);
      fetchCalls.push({ endpoint, body });
      const content = body.messages.map((msg) => msg.content).join('\n');
      const ids = [...content.matchAll(/"id": "(agt_[^"]+)"/g)].map((m) => m[1]);
      assert.equal(ids.length, 2, 'planner prompt embeds the agent roster');
      const reply = {
        acceptanceCriteria: ['Implementation reviewed', 'Verification independent'],
        tasks: [
          { id: 'impl-2', assignee: ids[0], instruction: 'Implement feature Y', dependencies: [] },
          { id: 'verify-2', assignee: ids[1], instruction: 'Verify feature Y', dependencies: ['impl-2'] },
        ],
      };
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }),
      };
    };

    server = new HiveServer({
      rootDir: repoRoot,
      port: 0,
      writeToken: false,
      tracePath: path.join(home, 'trace.jsonl'),
      collabDir: path.join(home, 'collab'),
      collaboration: {
        resolveExecutable: async (name) => ({ command: `fake-${name}`, prependArgs: [], resolvedFrom: 'test' }),
        detect: async () => ({ available: true, version: 'fake-1.0' }),
        runTurnImpl: turns.impl,
        killTree: (child) => child.kill('SIGKILL'),
      },
      model: { baseUrl: 'http://planner.test/v1', apiKey: 'test-key', model: 'planner-model' },
      fetchImpl: fakeFetch,
    });
    ({ url, token } = await server.listen());
  });

  after(async () => {
    await server.close();
    await new Promise((r) => setTimeout(r, 50));
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  let agentA;
  let agentB;

  it('registers agents and reports collaboration status', async () => {
    const a = await api('agents', { method: 'POST', body: { provider: 'codex', cwd: work, label: 'Codex A' } });
    assert.equal(a.status, 201);
    agentA = a.json.agent;
    assert.equal(agentA.state, 'idle');
    assert.equal(agentA.capabilities.available, true);

    const b = await api('agents', { method: 'POST', body: { provider: 'claude', cwd: work, label: 'Claude B' } });
    assert.equal(b.status, 201);
    agentB = b.json.agent;

    const list = await api('agents');
    assert.equal(list.status, 200);
    assert.equal(list.json.agents.length, 2);

    const status = await api('status');
    assert.equal(status.status, 200);
    assert.ok(status.json.collaboration, 'status includes collaboration summary');
    assert.equal(status.json.collaboration.agents.length, 2);

    // Invalid input is rejected with the collaboration error contract.
    const bad = await api('agents', { method: 'POST', body: { provider: 'gemini', cwd: work } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'INVALID_INPUT');
  });

  it('rejects API calls without the operator token', async () => {
    const res = await api('agents', { useToken: null });
    assert.equal(res.status, 401);
  });

  it('probes CLI capabilities without registering', async () => {
    const caps = await api('agents/capabilities');
    assert.equal(caps.status, 200);
    assert.ok(caps.json.capabilities.codex, 'codex probe present');
    assert.ok(caps.json.capabilities.claude, 'claude probe present');
    assert.equal(typeof caps.json.capabilities.codex.available, 'boolean');
  });

  it('runs a manual task graph end to end through the API', async () => {
    const created = await api('runs', {
      method: 'POST',
      body: {
        objective: 'Ship feature X',
        agentIds: [agentA.id, agentB.id],
        acceptanceCriteria: ['Implementation reviewed', 'Verification independent'],
        tasks: [
          { id: 'impl-1', assignee: agentA.id, instruction: 'Implement feature X' },
          { id: 'verify-1', assignee: agentB.id, instruction: 'Verify feature X', dependencies: ['impl-1'] },
        ],
      },
    });
    assert.equal(created.status, 201);
    const runId = created.json.run.id;
    assert.equal(created.json.tasks.length, 2);

    // The eligible task dispatches; the dependent one waits.
    const first = await waitFor(() => turns.calls[0], { label: 'first dispatch' });
    assert.match(first.prompt, /Implement feature X/);

    first.resolve({ ok: true, sessionId: 'ses-api-1', rawResult: doneResult({ summary: 'implemented' }) });
    const reviewable = await waitFor(async () => {
      const t = await api('tasks/impl-1');
      return t.json.task.state === 'awaiting_review' ? t.json.task : null;
    }, { label: 'impl-1 awaiting review' });

    const reviewed = await api('tasks/impl-1/review', {
      method: 'POST',
      body: { approved: true, evidence: 'Diff inspected locally', expectedRevision: reviewable.revision },
    });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.json.task.state, 'completed');

    const second = await waitFor(() => turns.calls[1], { label: 'dependent dispatch' });
    assert.match(second.prompt, /Verify feature X/);
    assert.match(second.prompt, /implemented/, 'dependency summary carried into prompt');

    second.resolve({ ok: true, sessionId: 'ses-api-2', rawResult: doneResult({ summary: 'verified' }) });
    const verifyTask = await waitFor(async () => {
      const t = await api('tasks/verify-1');
      return t.json.task.state === 'awaiting_review' ? t.json.task : null;
    }, { label: 'verify-1 awaiting review' });
    await api('tasks/verify-1/review', {
      method: 'POST',
      body: { approved: true, evidence: 'Checks reproduced', expectedRevision: verifyTask.revision },
    });

    const finished = await waitFor(async () => {
      const r = await api(`runs/${runId}`);
      return r.json.run.state === 'completed' ? r.json.run : null;
    }, { label: 'run completed' });
    assert.equal(finished.state, 'completed');

    // The receipt trail is exposed with the task.
    const detail = await api('tasks/impl-1');
    assert.equal(detail.json.receipts.length, 1);
    assert.equal(detail.json.receipts[0].outcome, 'done');
  });

  it('plans a run through the model, counts the decision, and cancels on request', async () => {
    const created = await api('runs', {
      method: 'POST',
      body: { objective: 'Add feature Y', agentIds: [agentA.id, agentB.id], plan: true },
    });
    assert.equal(created.status, 201);
    assert.equal(fetchCalls.length, 1, 'planner model was called');
    assert.match(fetchCalls[0].endpoint, /\/chat\/completions$/);

    const runId = created.json.run.id;
    const tasks = created.json.tasks;
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((t) => t.origin === 'planner'));
    assert.deepEqual(created.json.run.acceptanceCriteria, ['Implementation reviewed', 'Verification independent']);

    const withDecision = await api(`runs/${runId}`);
    assert.equal(withDecision.json.run.decisionsUsed, 1, 'planner decision counted against the run budget');

    // The first planned task starts, then the operator cancels the whole run.
    const call = await waitFor(() => turns.calls[2], { label: 'planned dispatch' });
    assert.match(call.prompt, /Implement feature Y/);
    assert.ok(call.child, 'child process registered');

    const cancelled = await api(`runs/${runId}/state`, {
      method: 'POST',
      body: { state: 'cancelled', reason: 'operator aborted', expectedRevision: withDecision.json.run.revision },
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.run.state, 'cancelled');
    assert.ok(call.child.killed, 'in-flight child was signalled');

    // The queued dependent task cancelled immediately; the running one
    // confirms when its killed turn ends.
    call.resolve({ ok: false, error: 'killed by operator', exitCode: null, timedOut: false });
    const finalTasks = await waitFor(async () => {
      const r = await api(`runs/${runId}`);
      return r.json.tasks.every((t) => t.state === 'cancelled') ? r.json.tasks : null;
    }, { label: 'all tasks cancelled' });
    assert.equal(finalTasks.length, 2);

    // Revision conflict is reported as 409.
    const conflict = await api(`runs/${runId}/state`, {
      method: 'POST',
      body: { state: 'active', expectedRevision: 999999 },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.code, 'REVISION_CONFLICT');
  });

  it('bridges hive send --to <agentId> into the durable message store', async () => {
    const sent = await api('send', {
      method: 'POST',
      body: { from: 'pane-human', to: agentA.id, kind: 'chat', text: 'what is your status?' },
    });
    assert.equal(sent.status, 200);
    const target = sent.json.targets.find((t) => t.target === agentA.id);
    assert.ok(target, 'agent resolved as a bus target');
    assert.equal(target.ok, true);
    assert.equal(target.channel, 'cli');

    const pending = server.collaboration.pendingMessagesFor(agentA.id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].text, 'what is your status?');
    assert.equal(pending[0].from, 'pane-human');
  });

  it('exposes collaboration state in the server status payload', async () => {
    const status = server.status();
    assert.ok(status.collaboration);
    assert.ok(Array.isArray(status.collaboration.runs));
    assert.ok(status.collaboration.runs.length >= 2);
    assert.ok(status.collaboration.agents.every((a) => typeof a.state === 'string'));
  });
});
