// CollaborationService: managed agents, runs, tasks, and the event-driven
// scheduling loop that binds them to the Codex/Claude adapters.
//
// Invariants enforced here (not by the models):
//   - one running task per agent; FIFO within an agent;
//   - dependencies must be *reviewed complete*, not merely "done";
//   - one workspace-write task per canonical directory at a time;
//   - attempts are persisted BEFORE the process spawns; a crash leaves the
//     task `uncertain`, never silently re-run;
//   - agent output is data: results pass validateAgentResult, follow-ups are
//     proposals checked against membership, depth, and budgets;
//   - peer messages are durable, at-least-once, and ride the next turn.
import { EventEmitter } from 'node:events';
import { realpath } from 'node:fs/promises';

import { makeId } from '../shared/protocol.js';
import {
  CollaborationError, directoryLockKey, effectivePermission,
  validateAgentInput, validateRunInput, validateTaskInput,
} from './collaboration-validation.js';
import { dependenciesComplete, taskTransition } from './collaboration-state.js';
import { validateAgentResult } from './collaboration-result.js';
import { buildResultSchema } from './agent-runtime/result-schema.js';
import { buildTurnPrompt } from './agent-runtime/turn-prompt.js';
import { ADAPTERS, detectCli, killProcessTree, runTurn } from './agent-runtime/adapters.js';
import { resolveCliExecutable } from './agent-runtime/resolve-cli.js';

const TERMINAL_TASK_STATES = ['completed', 'failed', 'cancelled'];
const ACTIVE_TASK_STATES = ['queued', 'running', 'awaiting_review', 'uncertain'];

const entityValue = (record, patch) => {
  const { id, revision, ...rest } = record;
  return { ...rest, ...patch };
};

function agentEnv(baseEnv, agent) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLIHIVE_PANE_')) delete env[key];
  }
  env.CLIHIVE_MANAGED_AGENT = '1';
  env.CLIHIVE_AGENT_ID = agent.id;
  // No hive token: managed agents talk through the structured result contract,
  // not the HTTP API (least privilege).
  delete env.CLIHIVE_TOKEN;
  return env;
}

export class CollaborationService extends EventEmitter {
  #children = new Map();      // attemptId -> child process (in-memory only)
  #inFlight = new Set();      // taskIds currently dispatching/running in memory
  #executables = new Map();   // agentId -> resolved executable
  #pumping = false;
  #pumpAgain = false;

  constructor({
    store,
    bus = null,
    tracer = null,
    now = () => Date.now(),
    ids = makeId,
    adapters = ADAPTERS,
    resolveExecutable = resolveCliExecutable,
    detect = detectCli,
    runTurnImpl = runTurn,
    killTree = killProcessTree,
    baseEnv = process.env,
    platform = process.platform,
  } = {}) {
    super();
    this.setMaxListeners(0);
    if (!store) throw new Error('CollaborationService requires a store');
    this.store = store;
    this.bus = bus;
    this.tracer = tracer;
    this.now = now;
    this.ids = ids;
    this.adapters = adapters;
    this.resolveExecutable = resolveExecutable;
    this.detect = detect;
    this.runTurnImpl = runTurnImpl;
    this.killTree = killTree;
    this.baseEnv = baseEnv;
    this.platform = platform;
  }

  // --- lifecycle -------------------------------------------------------------

  /** Restart recovery: in-flight attempts have no process anymore -> uncertain. */
  async init() {
    await this.store.transact((state) => {
      const ops = [];
      const now = this.now();
      for (const task of Object.values(state.tables.tasks)) {
        if (task.state === 'running') {
          const patch = taskTransition(task, {
            type: 'interrupted', attemptId: task.attemptId,
            reason: 'clihive restarted while this attempt was in flight',
          }, { authority: 'runtime', now });
          ops.push({ table: 'tasks', id: task.id, expectedRevision: task.revision, value: entityValue(task, patch) });
        }
      }
      for (const agent of Object.values(state.tables.agents)) {
        if (agent.state === 'running') {
          ops.push({ table: 'agents', id: agent.id, expectedRevision: agent.revision,
            value: entityValue(agent, { state: 'idle', activeTaskId: null, updatedAt: now }) });
        }
      }
      return ops;
    });
  }

  async close() {
    for (const child of this.#children.values()) this.killTree(child, this.platform);
    this.#children.clear();
  }

  // --- reads -----------------------------------------------------------------

  agent(id) { return this.store.get('agents', id); }
  run(id) { return this.store.get('runs', id); }
  task(id) { return this.store.get('tasks', id); }
  listAgents() { return this.store.list('agents'); }
  listRuns() { return this.store.list('runs'); }
  listTasks(runId = null) {
    return runId ? this.store.list('tasks').filter((t) => t.runId === runId) : this.store.list('tasks');
  }
  pendingMessagesFor(agentId) {
    return this.store.list('messages').filter((m) => m.to === agentId && m.state === 'pending');
  }
  receipt(attemptId) { return this.store.get('receipts', attemptId); }
  receiptsForTask(taskId) { return this.store.list('receipts').filter((r) => r.taskId === taskId); }

  status() {
    const agents = this.listAgents();
    const runs = this.listRuns();
    return {
      agents: agents.map((a) => ({
        id: a.id, provider: a.provider, label: a.label, state: a.state,
        available: a.capabilities?.available === true, version: a.capabilities?.version ?? null,
        permissionProfile: a.permissionProfile, cwd: a.cwd, activeTaskId: a.activeTaskId,
      })),
      runs: runs.map((r) => ({
        id: r.id, objective: r.objective, state: r.state, turnsUsed: r.turnsUsed,
        limits: r.limits, pendingQuestion: r.pendingQuestion ?? null,
      })),
      tasks: this.listTasks().map((t) => ({
        id: t.id, runId: t.runId, assignee: t.assignee, state: t.state,
        origin: t.origin, error: t.error, cancelRequested: !!t.cancelRequested,
      })),
    };
  }

  #trace(kind, detail) {
    if (this.tracer) this.tracer.emitTrace(kind, detail);
  }

  // --- agent registration ------------------------------------------------------

  async registerAgent(input) {
    const validated = validateAgentInput(input);
    let realCwd;
    try {
      realCwd = await realpath(validated.cwd);
    } catch {
      throw new CollaborationError(`cwd does not exist: ${validated.cwd}`);
    }
    const cwdKey = directoryLockKey(realCwd, this.platform);
    const id = this.ids('agt');

    let capabilities = { available: false, reason: 'not probed' };
    let resolvedFrom = null;
    try {
      const executable = await this.resolveExecutable(validated.provider);
      resolvedFrom = executable.resolvedFrom;
      this.#executables.set(id, executable);
      capabilities = await this.detect(executable, { timeoutMs: 30000 });
    } catch (err) {
      capabilities = { available: false, reason: err.message };
    }

    const now = this.now();
    await this.store.transact(() => [{ table: 'agents', id, expectedRevision: 0, value: {
      ...validated, cwd: realCwd, cwdKey, capabilities, resolvedFrom,
      state: 'idle', activeTaskId: null, sessionId: null,
      createdAt: now, updatedAt: now,
    } }]);
    this.#trace('agent.register', { agentId: id, provider: validated.provider, available: capabilities.available === true });
    const agent = this.agent(id);
    this.emit('agent', agent);
    return agent;
  }

  /** Count one planner decision against a run's budget. */
  async recordDecision(runId) {
    const now = this.now();
    await this.store.transact((state) => {
      const run = state.tables.runs[runId];
      if (!run) return [];
      return [{ table: 'runs', id: runId, expectedRevision: run.revision,
        value: entityValue(run, { decisionsUsed: (run.decisionsUsed ?? 0) + 1, updatedAt: now }) }];
    });
    return this.run(runId);
  }

  async #executableFor(agent) {
    let executable = this.#executables.get(agent.id);
    if (!executable) {
      executable = await this.resolveExecutable(agent.provider);
      this.#executables.set(agent.id, executable);
    }
    return executable;
  }

  // --- run/task creation -------------------------------------------------------

  #assertAcyclic(tasks) {
    const incoming = new Map(tasks.map((t) => [t.id, [...t.dependencies]]));
    const done = new Set();
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [id, deps] of incoming) {
        if (done.has(id)) continue;
        if (deps.every((d) => done.has(d))) { done.add(id); progressed = true; }
      }
    }
    if (done.size !== tasks.length) throw new CollaborationError('Task dependencies contain a cycle');
  }

  async createRun(input, taskInputs = []) {
    const validated = validateRunInput(input);
    const snapshot = this.store.snapshot();
    for (const agentId of validated.agentIds) {
      const agent = snapshot.tables.agents[agentId];
      if (!agent) throw new CollaborationError(`Unknown agent ${agentId}`);
      if (agent.capabilities?.available !== true) {
        throw new CollaborationError(`Agent ${agentId} is not available for managed turns: ${agent.capabilities?.reason ?? 'unknown reason'}`);
      }
    }
    const tasks = taskInputs.map((t) => validateTaskInput(t, { assigneeIds: validated.agentIds }));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const t of tasks) {
      if (snapshot.tables.tasks[t.id]) throw new CollaborationError(`Task id already exists: ${t.id}`);
      for (const dep of t.dependencies) {
        if (!byId.has(dep)) throw new CollaborationError(`Task ${t.id} depends on ${dep}, which is not part of this run`);
      }
    }
    this.#assertAcyclic(tasks);

    const runId = this.ids('run');
    const now = this.now();
    await this.store.transact(() => [
      { table: 'runs', id: runId, expectedRevision: 0, value: {
        ...validated, state: 'active', turnsUsed: 0, decisionsUsed: 0,
        pendingQuestion: null, reason: null, createdAt: now, updatedAt: now,
      } },
      ...tasks.map(({ id: taskId, ...fields }) => ({ table: 'tasks', id: taskId, expectedRevision: 0, value: {
        runId, ...fields, state: 'queued', attemptId: null, result: null, verification: null,
        error: null, cancelRequested: false, createdAt: now, updatedAt: now,
      } })),
    ]);
    this.#trace('run.create', { runId, agents: validated.agentIds, tasks: tasks.map((t) => t.id) });
    const run = this.run(runId);
    this.emit('run', run);
    await this.pump();
    return run;
  }

  /** Operator adds tasks to an existing run (same validation as creation). */
  async addTasks(runId, taskInputs) {
    const snapshot = this.store.snapshot();
    const run = snapshot.tables.runs[runId];
    if (!run) throw new CollaborationError(`Unknown run ${runId}`, 404);
    if (!['active', 'paused'].includes(run.state)) throw new CollaborationError(`Run is ${run.state}`, 409, 'INVALID_TRANSITION');
    const tasks = taskInputs.map((t) => validateTaskInput(t, { assigneeIds: run.agentIds }));
    const known = new Set(Object.keys(snapshot.tables.tasks));
    const newIds = new Set(tasks.map((t) => t.id));
    for (const t of tasks) {
      if (known.has(t.id)) throw new CollaborationError(`Task id already exists: ${t.id}`);
      for (const dep of t.dependencies) {
        if (!known.has(dep) && !newIds.has(dep)) {
          throw new CollaborationError(`Task ${t.id} depends on unknown task ${dep}`);
        }
        if (known.has(dep) && snapshot.tables.tasks[dep].runId !== runId) {
          throw new CollaborationError(`Task ${t.id} depends on task ${dep} from another run`);
        }
      }
    }
    // Only edges among the NEW tasks can introduce a cycle: existing tasks
    // were validated earlier and cannot depend on ids created just now.
    this.#assertAcyclic(tasks.map((t) => ({ ...t, dependencies: t.dependencies.filter((d) => newIds.has(d)) })));
    const now = this.now();
    await this.store.transact(() => tasks.map(({ id: taskId, ...fields }) => ({ table: 'tasks', id: taskId, expectedRevision: 0, value: {
      runId, ...fields, state: 'queued', attemptId: null, result: null, verification: null,
      error: null, cancelRequested: false, createdAt: now, updatedAt: now,
    } })));
    await this.pump();
    return tasks.map((t) => this.task(t.id));
  }

  // --- scheduling ----------------------------------------------------------------

  async pump() {
    if (this.#pumping) { this.#pumpAgain = true; return; }
    this.#pumping = true;
    try {
      let guard = 0;
      let dispatched = true;
      while (dispatched && guard < 64) {
        guard += 1;
        dispatched = false;
        await this.#enforceRunGuards();
        await this.#ensureMessageTurns();
        const snapshot = this.store.snapshot();
        // Decisions in this pass are not in the store yet (their start
        // transactions are still in flight), so consistency checks must
        // consider the batch as well as persisted state.
        const batch = [];
        for (const task of Object.values(snapshot.tables.tasks)) {
          if (task.state !== 'queued' || this.#inFlight.has(task.id)) continue;
          const decision = this.#evaluate(snapshot, task, batch);
          if (!decision) continue;
          batch.push(decision);
          dispatched = true;
          this.#inFlight.add(task.id);
          void this.#dispatch(task.id, decision).catch((err) => {
            this.#inFlight.delete(task.id);
            this.#trace('task.dispatch-error', { taskId: task.id, error: err.message });
            this.pump().catch(() => {});
          });
        }
      }
    } finally {
      this.#pumping = false;
      if (this.#pumpAgain) { this.#pumpAgain = false; this.pump().catch(() => {}); }
    }
  }

  #evaluate(snapshot, task, batch = []) {
    const run = snapshot.tables.runs[task.runId];
    if (!run || run.state !== 'active') return null;
    if ((run.turnsUsed ?? 0) >= run.limits.agentTurns) return null;
    const agent = snapshot.tables.agents[task.assignee];
    if (!agent || agent.state !== 'idle' || agent.capabilities?.available !== true) return null;
    if (!dependenciesComplete(task, snapshot.tables.tasks)) return null;

    // One running task per agent, counting both persisted and in-batch state.
    const batchAgents = new Set(batch.map((d) => d.agent.id));
    if (batchAgents.has(agent.id)) return null;
    const agentBusy = Object.values(snapshot.tables.tasks).some((t) => t.state === 'running' && t.assignee === agent.id);
    if (agentBusy) return null;

    const tasks = Object.values(snapshot.tables.tasks);
    const runningInRun = tasks.filter((t) => t.runId === run.id && t.state === 'running').length
      + batch.filter((d) => d.run.id === run.id).length;
    if (runningInRun >= run.limits.concurrency) return null;

    const permission = effectivePermission(agent.permissionProfile, run.permissionProfile);
    if (permission === 'workspace-write') {
      // One writer per canonical directory, across runs, persisted or batched.
      const persistedWriter = tasks.some((t) => {
        if (t.state !== 'running' || t.id === task.id) return false;
        const otherAgent = snapshot.tables.agents[t.assignee];
        const otherRun = snapshot.tables.runs[t.runId];
        if (!otherAgent || !otherRun) return false;
        return otherAgent.cwdKey === agent.cwdKey
          && effectivePermission(otherAgent.permissionProfile, otherRun.permissionProfile) === 'workspace-write';
      });
      const batchWriter = batch.some((d) => d.permission === 'workspace-write' && d.agent.cwdKey === agent.cwdKey);
      if (persistedWriter || batchWriter) return null;
    }
    return { taskId: task.id, agent, run, permission };
  }

  async #enforceRunGuards() {
    const now = this.now();
    await this.store.transact((state) => {
      const ops = [];
      for (const run of Object.values(state.tables.runs)) {
        if (run.state !== 'active') continue;
        let reason = null;
        if ((run.turnsUsed ?? 0) >= run.limits.agentTurns) reason = 'budget-exhausted:agentTurns';
        else if ((run.decisionsUsed ?? 0) >= run.limits.decisions) reason = 'budget-exhausted:decisions';
        else if (now - run.createdAt > run.limits.runTimeoutMs) reason = 'run-timeout';
        if (!reason) continue;
        ops.push({ table: 'runs', id: run.id, expectedRevision: run.revision,
          value: entityValue(run, { state: 'paused', reason, updatedAt: now }) });
        // Queued work cannot start while paused; running attempts keep going
        // until their own task timeout or an operator cancel.
      }
      return ops;
    });
  }

  /** Idle agents with pending run messages get an automatic response turn. */
  async #ensureMessageTurns() {
    await this.store.transact((state) => {
      const ops = [];
      const now = this.now();
      const pending = Object.values(state.tables.messages).filter((m) => m.state === 'pending' && m.runId);
      const byRecipient = new Map();
      for (const m of pending) {
        if (!byRecipient.has(m.to)) byRecipient.set(m.to, []);
        byRecipient.get(m.to).push(m);
      }
      for (const [agentId, msgs] of byRecipient) {
        const agent = state.tables.agents[agentId];
        if (!agent || agent.capabilities?.available !== true) continue;
        const runIds = [...new Set(msgs.map((m) => m.runId))];
        for (const runId of runIds) {
          const run = state.tables.runs[runId];
          if (!run || run.state !== 'active') continue;
          const hasWork = Object.values(state.tables.tasks).some((t) => t.runId === runId
            && t.assignee === agentId && ACTIVE_TASK_STATES.includes(t.state));
          if (hasWork) continue; // the messages ride that turn instead
          const depth = Math.max(...msgs.map((m) => m.depth ?? 1));
          if (depth > run.limits.handoffDepth) continue;
          const id = this.ids('task');
          ops.push({ table: 'tasks', id, expectedRevision: 0, value: {
            runId, assignee: agentId,
            instruction: 'Respond to your pending peer/operator messages. Read them in the Messages section, act if asked, and reply through result.messages. If nothing is asked of you, summarize with outcome "done".',
            dependencies: [], writeScopes: [], origin: 'message', depth,
            state: 'queued', attemptId: null, result: null, verification: null,
            error: null, cancelRequested: false, createdAt: now, updatedAt: now,
          } });
        }
      }
      return ops;
    });
  }

  // --- dispatch ------------------------------------------------------------------

  async #dispatch(taskId, decision) {
    const { agent, run, permission } = decision;
    const attemptId = this.ids('att');
    const snapshot = this.store.snapshot();
    const task = snapshot.tables.tasks[taskId];
    const pending = Object.values(snapshot.tables.messages)
      .filter((m) => m.to === agent.id && m.state === 'pending' && (!m.runId || m.runId === run.id));
    const dependencyResults = task.dependencies
      .map((id) => snapshot.tables.tasks[id])
      .filter(Boolean)
      .map((t) => ({ id: t.id, summary: t.result?.summary ?? '(no summary)', verification: t.verification ?? null }));
    const peers = run.agentIds
      .filter((id) => id !== agent.id)
      .map((id) => snapshot.tables.agents[id])
      .filter(Boolean)
      .map((a) => ({ id: a.id, label: a.label, provider: a.provider }));

    const prompt = buildTurnPrompt({
      agent, run, task: { ...task, cwd: agent.cwd },
      permissionProfile: permission, peers, dependencyResults,
      inbox: pending.map((m) => ({ from: m.from, text: m.text })),
    });

    // Persist the attempt BEFORE any process exists.
    const now = this.now();
    await this.store.transact((state) => {
      const current = state.tables.tasks[taskId];
      const currentAgent = state.tables.agents[agent.id];
      const currentRun = state.tables.runs[run.id];
      const patch = taskTransition(current, { type: 'start', attemptId }, { authority: 'runtime', now });
      return [
        { table: 'tasks', id: taskId, expectedRevision: current.revision, value: entityValue(current, patch) },
        { table: 'agents', id: agent.id, expectedRevision: currentAgent.revision,
          value: entityValue(currentAgent, { state: 'running', activeTaskId: taskId, updatedAt: now }) },
        { table: 'runs', id: run.id, expectedRevision: currentRun.revision,
          value: entityValue(currentRun, { turnsUsed: (currentRun.turnsUsed ?? 0) + 1, updatedAt: now }) },
        { table: 'receipts', id: attemptId, expectedRevision: 0, value: {
          taskId, runId: run.id, agentId: agent.id, provider: agent.provider,
          permissionProfile: permission, promptChars: prompt.length,
          deliveredMessageIds: pending.map((m) => m.id),
          startedAt: now, endedAt: null, outcome: null, error: null,
          sessionId: null, exitCode: null, timedOut: false, permissionDenied: false, warnings: [],
        } },
      ];
    });

    this.#trace('task.dispatch', { taskId, attemptId, agentId: agent.id, runId: run.id, permissionProfile: permission, promptChars: prompt.length });
    this.emit('task', this.task(taskId));

    let outcome;
    try {
      const executable = await this.#executableFor(agent);
      const schema = buildResultSchema({
        recipientIds: run.agentIds.filter((id) => id !== agent.id),
        messagesPerTurn: run.limits.messagesPerTurn,
      });
      let permissionDenied = false;
      outcome = await this.runTurnImpl(this.adapters[agent.provider], {
        executable, prompt, cwd: agent.cwd, permissionProfile: permission,
        sessionId: agent.sessionId ?? null, schema,
        timeoutMs: run.limits.taskTimeoutMs,
        env: agentEnv(this.baseEnv, agent),
        platform: this.platform, attemptId,
        onSpawn: (child) => this.#children.set(attemptId, child),
        onEvent: (event) => {
          if (event.type === 'permission_denied') permissionDenied = true;
          this.emit('agent-event', { agentId: agent.id, taskId, attemptId, event });
          if (['permission_denied', 'error', 'result', 'exit'].includes(event.type)) {
            this.#trace(`agent.${event.type}`, { agentId: agent.id, taskId, attemptId });
          }
        },
      });
      outcome.permissionDenied = permissionDenied;
    } catch (err) {
      outcome = { ok: false, error: `dispatch failure: ${err.message}`, sessionId: null, rawResult: null, exitCode: null, timedOut: false };
    } finally {
      this.#children.delete(attemptId);
    }

    await this.#completeAttempt(taskId, attemptId, outcome);
    this.#inFlight.delete(taskId);
    await this.#settle(run.id);
    await this.pump();
  }

  #completeAttempt(taskId, attemptId, outcome) {
    return this.store.transact((state) => {
      const now = this.now();
      const task = state.tables.tasks[taskId];
      const receipt = state.tables.receipts[attemptId];
      if (!task || !receipt) return [];
      const agent = state.tables.agents[task.assignee];
      const run = state.tables.runs[task.runId];
      const ops = [];
      const warnings = [];

      if (task.state !== 'running' || task.attemptId !== attemptId) {
        // Already cancelled/confirmed elsewhere; just close the receipt.
        ops.push({ table: 'receipts', id: attemptId, expectedRevision: receipt.revision,
          value: entityValue(receipt, { endedAt: now, outcome: 'stale', error: outcome.error ?? null,
            sessionId: outcome.sessionId ?? null, exitCode: outcome.exitCode ?? null,
            timedOut: outcome.timedOut === true, permissionDenied: outcome.permissionDenied === true }) });
        if (agent?.state === 'running' && agent.activeTaskId === taskId) {
          ops.push({ table: 'agents', id: agent.id, expectedRevision: agent.revision,
            value: entityValue(agent, { state: 'idle', activeTaskId: null, updatedAt: now }) });
        }
        return ops;
      }

      if (task.cancelRequested) {
        const patch = taskTransition(task, { type: 'cancel_confirmed', attemptId, processStopped: true }, { authority: 'runtime', now });
        ops.push({ table: 'tasks', id: taskId, expectedRevision: task.revision, value: entityValue(task, patch) });
        ops.push({ table: 'receipts', id: attemptId, expectedRevision: receipt.revision,
          value: entityValue(receipt, { endedAt: now, outcome: 'cancelled', error: outcome.error ?? null,
            sessionId: outcome.sessionId ?? null, exitCode: outcome.exitCode ?? null,
            timedOut: outcome.timedOut === true, permissionDenied: outcome.permissionDenied === true }) });
        this.#markMessagesDelivered(state, receipt.deliveredMessageIds, attemptId, now, ops);
      } else if (outcome.ok) {
        let result = null;
        try {
          result = validateAgentResult(outcome.rawResult, {
            recipientIds: run.agentIds.filter((id) => id !== task.assignee),
            messagesPerTurn: run.limits.messagesPerTurn,
          });
        } catch (err) {
          warnings.push(`structured result rejected: ${err.message}`);
        }
        const effectiveResult = result ?? {
          summary: `Structured result rejected by the hive: ${outcome.rawResult === null ? 'no result object' : 'schema violation'}`,
          outcome: 'failed', artifacts: [], checks: [], messages: [], followUps: [], question: null,
        };
        const patch = taskTransition(task, { type: 'result', attemptId, result: effectiveResult }, { authority: 'runtime', now });
        let taskAfter = { ...task, ...patch };
        ops.push({ table: 'tasks', id: taskId, expectedRevision: task.revision, value: entityValue(task, patch) });

        if (result) {
          // Durable peer messages (at-least-once; delivered on the next turn).
          for (const msg of result.messages) {
            const id = this.ids('msg');
            ops.push({ table: 'messages', id, expectedRevision: 0, value: {
              runId: task.runId, taskId, from: task.assignee, to: msg.to, text: msg.text,
              state: 'pending', depth: (task.depth ?? 0) + 1, createdAt: now, deliveredByAttempt: null,
            } });
          }
          // Follow-ups are proposals: membership was checked by validateAgentResult;
          // here we check dependency references and the handoff depth budget.
          for (const follow of result.followUps) {
            const depth = (task.depth ?? 0) + 1;
            if (depth > run.limits.handoffDepth) {
              warnings.push(`follow-up for ${follow.assignee} dropped: handoff depth ${depth} exceeds ${run.limits.handoffDepth}`);
              continue;
            }
            const badDep = follow.dependencies.find((dep) => !state.tables.tasks[dep] || state.tables.tasks[dep].runId !== task.runId);
            if (badDep) {
              warnings.push(`follow-up for ${follow.assignee} dropped: depends on unknown task ${badDep}`);
              continue;
            }
            const id = this.ids('task');
            ops.push({ table: 'tasks', id, expectedRevision: 0, value: {
              runId: task.runId, assignee: follow.assignee, instruction: follow.instruction,
              dependencies: follow.dependencies, writeScopes: [], origin: 'followup', depth,
              state: 'queued', attemptId: null, result: null, verification: null,
              error: null, cancelRequested: false, createdAt: now, updatedAt: now,
            } });
          }
          if (effectiveResult.outcome === 'blocked' && effectiveResult.question) {
            ops.push({ table: 'runs', id: run.id, expectedRevision: run.revision,
              value: entityValue(run, { pendingQuestion: { taskId, agentId: task.assignee, question: effectiveResult.question, at: now }, updatedAt: now }) });
          }
          // Message-response turns are auto-reviewed; everything else waits for
          // the operator (taskAfter.state === 'awaiting_review' only when done).
          if (taskAfter.state === 'awaiting_review' && task.origin === 'message') {
            const reviewPatch = taskTransition(taskAfter, { type: 'review', attemptId, approved: true, evidence: 'automatic review of a peer-message response turn' }, { authority: 'service', now });
            taskAfter = { ...taskAfter, ...reviewPatch };
            ops[ops.findIndex((op) => op.table === 'tasks' && op.id === taskId)].value = entityValue(task, { ...patch, ...reviewPatch });
          }
        }
        this.#markMessagesDelivered(state, receipt.deliveredMessageIds, attemptId, now, ops);
        ops.push({ table: 'receipts', id: attemptId, expectedRevision: receipt.revision,
          value: entityValue(receipt, { endedAt: now, outcome: effectiveResult.outcome, error: null,
            sessionId: outcome.sessionId ?? null, exitCode: outcome.exitCode ?? null,
            timedOut: outcome.timedOut === true, permissionDenied: outcome.permissionDenied === true, warnings }) });
      } else {
        const summary = `Agent turn failed: ${outcome.error}`;
        const patch = taskTransition(task, { type: 'result', attemptId,
          result: { outcome: 'failed', summary, artifacts: [], checks: [], messages: [], followUps: [], question: null } },
        { authority: 'runtime', now });
        ops.push({ table: 'tasks', id: taskId, expectedRevision: task.revision, value: entityValue(task, patch) });
        this.#markMessagesDelivered(state, receipt.deliveredMessageIds, attemptId, now, ops);
        ops.push({ table: 'receipts', id: attemptId, expectedRevision: receipt.revision,
          value: entityValue(receipt, { endedAt: now, outcome: 'failed', error: outcome.error ?? 'unknown',
            sessionId: outcome.sessionId ?? null, exitCode: outcome.exitCode ?? null,
            timedOut: outcome.timedOut === true, permissionDenied: outcome.permissionDenied === true, warnings }) });
      }

      if (agent) {
        ops.push({ table: 'agents', id: agent.id, expectedRevision: agent.revision,
          value: entityValue(agent, {
            state: 'idle', activeTaskId: null, updatedAt: now,
            sessionId: outcome.sessionId ?? agent.sessionId ?? null,
          }) });
      }
      return ops;
    }).then(() => {
      this.#trace('task.attempt-end', { taskId, attemptId, ok: outcome.ok === true });
      this.emit('task', this.task(taskId));
    });
  }

  #markMessagesDelivered(state, messageIds, attemptId, now, ops) {
    for (const id of messageIds ?? []) {
      const msg = state.tables.messages[id];
      if (msg && msg.state === 'pending') {
        ops.push({ table: 'messages', id, expectedRevision: msg.revision,
          value: entityValue(msg, { state: 'delivered', deliveredByAttempt: attemptId, deliveredAt: now }) });
      }
    }
  }

  // --- run settling ----------------------------------------------------------------

  async #settle(runId) {
    await this.store.transact((state) => {
      const run = state.tables.runs[runId];
      if (!run || run.state !== 'active') return [];
      const tasks = Object.values(state.tables.tasks).filter((t) => t.runId === runId);
      const now = this.now();
      const anyActive = tasks.some((t) => ACTIVE_TASK_STATES.includes(t.state));
      const anyWaitingReview = tasks.some((t) => t.state === 'awaiting_review');
      const allCompleted = tasks.length > 0 && tasks.every((t) => t.state === 'completed');
      if (allCompleted && !run.pendingQuestion) {
        return [{ table: 'runs', id: runId, expectedRevision: run.revision,
          value: entityValue(run, { state: 'completed', reason: null, updatedAt: now }) }];
      }
      // A pending operator question keeps the run alive (waiting for a human),
      // not failed: respondToRun clears it and scheduling resumes.
      if (!anyActive && !anyWaitingReview && !run.pendingQuestion
          && tasks.some((t) => ['failed', 'cancelled'].includes(t.state))) {
        return [{ table: 'runs', id: runId, expectedRevision: run.revision,
          value: entityValue(run, { state: 'failed', reason: 'stalled: tasks ended in failure or cancellation', updatedAt: now }) }];
      }
      return [];
    }).then(() => this.emit('run', this.run(runId)));
  }

  // --- operator actions ---------------------------------------------------------------

  async reviewTask(taskId, { approved, evidence, expectedRevision }) {
    const now = this.now();
    await this.store.transact((state) => {
      const task = state.tables.tasks[taskId];
      if (!task) throw new CollaborationError(`Unknown task ${taskId}`, 404);
      if (task.revision !== expectedRevision) throw new CollaborationError('Task changed since it was read', 409, 'REVISION_CONFLICT');
      const patch = taskTransition(task, { type: 'review', attemptId: task.attemptId, approved, evidence }, { authority: 'operator', now });
      const ops = [{ table: 'tasks', id: taskId, expectedRevision: task.revision, value: entityValue(task, patch) }];
      if (approved) {
        const run = state.tables.runs[task.runId];
        if (run?.pendingQuestion?.taskId === taskId) {
          ops.push({ table: 'runs', id: run.id, expectedRevision: run.revision,
            value: entityValue(run, { pendingQuestion: null, updatedAt: now }) });
        }
      }
      return ops;
    });
    this.#trace('task.review', { taskId, approved });
    this.emit('task', this.task(taskId));
    const task = this.task(taskId);
    await this.#settle(task.runId);
    await this.pump();
    return task;
  }

  async cancelTask(taskId, { expectedRevision }) {
    const now = this.now();
    let attemptToKill = null;
    await this.store.transact((state) => {
      const task = state.tables.tasks[taskId];
      if (!task) throw new CollaborationError(`Unknown task ${taskId}`, 404);
      if (task.revision !== expectedRevision) throw new CollaborationError('Task changed since it was read', 409, 'REVISION_CONFLICT');
      const patch = taskTransition(task, { type: 'cancel_requested' }, { authority: 'operator', now });
      if (task.state === 'running') attemptToKill = task.attemptId;
      return [{ table: 'tasks', id: taskId, expectedRevision: task.revision, value: entityValue(task, patch) }];
    });
    if (attemptToKill) {
      const child = this.#children.get(attemptToKill);
      if (child) this.killTree(child, this.platform);
      // The dispatch loop's completion path persists cancel_confirmed on exit.
    }
    this.#trace('task.cancel', { taskId });
    this.emit('task', this.task(taskId));
    const task = this.task(taskId);
    await this.#settle(task.runId);
    await this.pump();
    return task;
  }

  async retryTask(taskId, { reason, previousProcessStopped, sideEffectsReviewed, expectedRevision }) {
    const now = this.now();
    await this.store.transact((state) => {
      const task = state.tables.tasks[taskId];
      if (!task) throw new CollaborationError(`Unknown task ${taskId}`, 404);
      if (task.revision !== expectedRevision) throw new CollaborationError('Task changed since it was read', 409, 'REVISION_CONFLICT');
      const patch = taskTransition(task, { type: 'retry', reason, previousProcessStopped, sideEffectsReviewed }, { authority: 'operator', now });
      return [{ table: 'tasks', id: taskId, expectedRevision: task.revision, value: entityValue(task, patch) }];
    });
    this.#trace('task.retry', { taskId });
    this.emit('task', this.task(taskId));
    const task = this.task(taskId);
    // A retried task re-enters scheduling; the run may need to leave 'failed'.
    await this.store.transact((state) => {
      const run = state.tables.runs[task.runId];
      if (run && run.state === 'failed') {
        return [{ table: 'runs', id: run.id, expectedRevision: run.revision,
          value: entityValue(run, { state: 'active', reason: null, updatedAt: this.now() }) }];
      }
      return [];
    });
    await this.pump();
    return task;
  }

  async setRunState(runId, nextState, { expectedRevision, reason = null }) {
    if (!['active', 'paused', 'cancelled'].includes(nextState)) {
      throw new CollaborationError('Run state must be active, paused, or cancelled');
    }
    const now = this.now();
    let run;
    await this.store.transact((state) => {
      run = state.tables.runs[runId];
      if (!run) throw new CollaborationError(`Unknown run ${runId}`, 404);
      if (run.revision !== expectedRevision) throw new CollaborationError('Run changed since it was read', 409, 'REVISION_CONFLICT');
      if (['completed', 'failed', 'cancelled'].includes(run.state) && nextState !== 'cancelled') {
        throw new CollaborationError(`Run is ${run.state}`, 409, 'INVALID_TRANSITION');
      }
      const ops = [{ table: 'runs', id: runId, expectedRevision: run.revision,
        value: entityValue(run, { state: nextState, reason, updatedAt: now }) }];
      if (nextState === 'cancelled') {
        // Flag every non-terminal task: queued ones cancel immediately; the
        // running one keeps its flag and lands in `cancelled` when its killed
        // process ends and the completion path confirms.
        for (const task of Object.values(state.tables.tasks)) {
          if (task.runId !== runId || TERMINAL_TASK_STATES.includes(task.state)) continue;
          const patch = taskTransition(task, { type: 'cancel_requested' }, { authority: 'operator', now });
          ops.push({ table: 'tasks', id: task.id, expectedRevision: task.revision, value: entityValue(task, patch) });
        }
      }
      return ops;
    });
    if (nextState === 'cancelled') {
      // Kill every in-flight child belonging to this run; confirmations land
      // through the normal completion path.
      for (const task of this.listTasks(runId)) {
        if (task.state === 'running' && task.attemptId) {
          const child = this.#children.get(task.attemptId);
          if (child) this.killTree(child, this.platform);
        }
      }
    }
    this.#trace('run.state', { runId, state: nextState, reason });
    this.emit('run', this.run(runId));
    await this.pump();
    return this.run(runId);
  }

  /** Operator answer to a blocked run: persists the reply and wakes the agent. */
  async respondToRun(runId, { text, expectedRevision }) {
    const answer = requiredTextShim(text);
    const now = this.now();
    let targetAgentId = null;
    await this.store.transact((state) => {
      const run = state.tables.runs[runId];
      if (!run) throw new CollaborationError(`Unknown run ${runId}`, 404);
      if (run.revision !== expectedRevision) throw new CollaborationError('Run changed since it was read', 409, 'REVISION_CONFLICT');
      const question = run.pendingQuestion;
      targetAgentId = question?.agentId ?? null;
      const ops = [];
      if (question) {
        ops.push({ table: 'runs', id: runId, expectedRevision: run.revision,
          value: entityValue(run, { pendingQuestion: null, state: run.state === 'paused' ? 'paused' : run.state, updatedAt: now }) });
        const id = this.ids('msg');
        ops.push({ table: 'messages', id, expectedRevision: 0, value: {
          runId, taskId: question.taskId, from: 'operator', to: question.agentId, text: `Operator answer to your question: ${answer}`,
          state: 'pending', depth: 0, createdAt: now, deliveredByAttempt: null,
        } });
      }
      return ops;
    });
    if (targetAgentId) {
      this.#trace('run.respond', { runId, agentId: targetAgentId });
      await this.pump();
    }
    return this.run(runId);
  }

  /**
   * Bridge for messages coming from panes/humans through the bus. Persisted
   * first (durable), then the agent is woken with a message turn if idle.
   */
  async deliverExternalMessage({ from, to, text, runId = null }) {
    const agent = this.agent(to);
    if (!agent) throw new CollaborationError(`Unknown managed agent ${to}`, 404);
    const body = requiredTextShim(text);
    const sender = requiredTextShim(from);
    const now = this.now();
    let activeRunId = runId;
    if (!activeRunId) {
      const running = this.listRuns().find((r) => r.state === 'active' && r.agentIds.includes(to));
      activeRunId = running?.id ?? null;
    }
    const id = this.ids('msg');
    await this.store.transact(() => [{ table: 'messages', id, expectedRevision: 0, value: {
      runId: activeRunId, taskId: null, from: sender, to, text: body,
      state: 'pending', depth: 0, createdAt: now, deliveredByAttempt: null,
    } }]);
    this.#trace('msg.agent-queued', { messageId: id, from: sender, to });
    await this.pump();
    return this.store.get('messages', id);
  }
}

// Local guard mirroring requiredText without importing it twice at call sites.
function requiredTextShim(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 16000) {
    throw new CollaborationError('text must be a nonempty string of at most 16000 characters');
  }
  return value.trim();
}
