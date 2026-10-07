// The orchestrator: the hideable big window on the right.
//
// It is the only participant that can see every pane and address all of them at
// once. It has two modes:
//
//   - manual: the human types, the orchestrator relays. Always available.
//   - model:  an LLM endpoint turns the hive state into instructions.
//
// Model mode is optional and off unless CLIHIVE_API_KEY (or an explicit config)
// is present, so the window is useful with zero setup.

import { EventEmitter } from 'node:events';

import {
  ADDRESS_ALL,
  ADDRESS_ORCHESTRATOR,
  MESSAGE_KINDS,
  TRACE,
  makeId,
} from '../shared/protocol.js';

const SYSTEM_PROMPT = `You coordinate several CLI agents that each run in their own pane of one window.

You see the shared transcript and the pane roster. Reply with a JSON object:
{
  "say": "text shown to the human in the orchestrator panel",
  "actions": [
    { "to": "<pane id> | all", "kind": "task" | "chat", "text": "instruction" }
  ]
}

Rules:
- Address a specific pane by its id when the work belongs to one pane.
- Use "all" only for information every pane needs.
- Keep instructions concrete and self-contained; a pane sees only its own
  terminal plus the shared transcript.
- "actions" may be empty when nothing needs to be dispatched.
- Reply with JSON only, no prose outside the object.`;

const PLAN_SYSTEM_PROMPT = `You decompose one collaboration objective into a small task graph for managed CLI agents.

Reply with JSON only:
{
  "acceptanceCriteria": ["criterion", "..."],
  "tasks": [
    { "id": "kebab-case-id", "assignee": "<agent id>", "instruction": "self-contained instruction", "dependencies": ["kebab-case-id"] }
  ]
}

Rules:
- At most 12 tasks. Dependencies may only reference tasks in this same list.
- Every assignee must be exactly one of the provided agent ids.
- Each instruction must be self-contained: the agent sees only its task text,
  the run objective, and the summarized results of its dependencies.
- When the objective can modify files, include an independent verification
  task assigned to a different agent than the implementer when possible.
- Acceptance criteria must be observable outcomes, not intentions.`;

/** Pull the first balanced JSON object out of a model reply. */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export class Orchestrator extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('./bus.js').MessageBus} deps.bus
   * @param {import('./panes.js').PaneManager} deps.panes
   * @param {import('./tracer.js').Tracer} deps.tracer
   * @param {object} [deps.model] `{ baseUrl, apiKey, model }`
   * @param {typeof fetch} [deps.fetchImpl] Injectable for tests.
   */
  constructor({ bus, panes, tracer, model, fetchImpl } = {}) {
    super();
    this.setMaxListeners(0);
    this.bus = bus;
    this.panes = panes;
    this.tracer = tracer;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;

    const baseUrl = model?.baseUrl ?? process.env.CLIHIVE_BASE_URL ?? '';
    const apiKey = model?.apiKey ?? process.env.CLIHIVE_API_KEY ?? '';
    const name = model?.model ?? process.env.CLIHIVE_MODEL ?? '';
    this.model = baseUrl && apiKey && name ? { baseUrl, apiKey, model: name } : null;
    /** @type {object[]} Orchestrator-side conversation log. */
    this.log = [];
  }

  get mode() {
    return this.model ? 'model' : 'manual';
  }

  status() {
    return {
      mode: this.mode,
      model: this.model ? this.model.model : null,
      turns: this.log.length,
    };
  }

  #note(entry) {
    const record = { id: makeId('orc'), ts: Date.now(), ...entry };
    this.log.push(record);
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
    this.emit('entry', record);
    return record;
  }

  /** Recent orchestrator panel entries. */
  recent(limit = 100) {
    return this.log.slice(-Math.max(0, limit));
  }

  /**
   * Relay a message straight to panes, no model involved.
   *
   * @param {object} spec
   * @param {string} [spec.to]
   * @param {string} spec.text
   * @param {string} [spec.kind]
   */
  async dispatch(spec) {
    const to = spec.to || ADDRESS_ALL;
    const kind = spec.kind || MESSAGE_KINDS.TASK;
    const result = await this.bus.publish(
      { from: ADDRESS_ORCHESTRATOR, to, kind, text: spec.text },
      { origin: 'orchestrator', paneIds: this.panes.aliveIds() },
    );

    this.tracer.emitTrace(TRACE.ORCH_ACTION, {
      messageId: result.message.id,
      to,
      msgKind: kind,
      delivered: result.deliveries.filter((d) => d.ok).length,
      failed: result.deliveries.filter((d) => !d.ok).length,
    });

    this.#note({
      role: 'orchestrator',
      text: spec.text,
      to,
      kind,
      messageId: result.message.id,
      deliveries: result.deliveries,
    });

    return result;
  }

  /**
   * A human turn in the right-hand window.
   *
   * In manual mode the text is relayed to the addressed panes. In model mode
   * the model decides what to say and which panes to dispatch to.
   *
   * @param {object} spec
   * @param {string} spec.text
   * @param {string} [spec.to] Manual-mode address; defaults to `all`.
   * @returns {Promise<{say: string, actions: object[], mode: string}>}
   */
  async ask(spec) {
    const text = typeof spec?.text === 'string' ? spec.text.trim() : '';
    if (!text) throw new Error('orchestrator ask requires text');

    this.tracer.emitTrace(TRACE.ORCH_PROMPT, {
      mode: this.mode,
      chars: text.length,
      to: spec.to ?? ADDRESS_ALL,
    });
    this.#note({ role: 'human', text, to: spec.to ?? ADDRESS_ALL });

    if (!this.model) {
      const result = await this.dispatch({ to: spec.to ?? ADDRESS_ALL, text, kind: MESSAGE_KINDS.TASK });
      const say = `Relayed to ${result.deliveries.length} target(s): `
        + result.deliveries.map((d) => `${d.target}${d.ok ? '' : ' (failed)'}`).join(', ');
      this.#note({ role: 'system', text: say });
      return { say, actions: [{ to: spec.to ?? ADDRESS_ALL, text }], mode: 'manual' };
    }

    let reply;
    try {
      reply = await this.#callModel(text);
    } catch (err) {
      const message = err?.message ?? String(err);
      this.tracer.emitTrace(TRACE.ORCH_ERROR, { error: message });
      this.#note({ role: 'error', text: message });
      return { say: `Model call failed: ${message}`, actions: [], mode: 'model' };
    }

    const parsed = extractJson(reply) ?? { say: reply, actions: [] };
    const say = typeof parsed.say === 'string' && parsed.say.trim() ? parsed.say.trim() : '(no comment)';
    const actions = Array.isArray(parsed.actions) ? parsed.actions : [];

    this.tracer.emitTrace(TRACE.ORCH_REPLY, {
      chars: reply.length,
      actionCount: actions.length,
    });
    this.#note({ role: 'assistant', text: say });

    const applied = [];
    for (const action of actions.slice(0, 16)) {
      if (!action || typeof action.text !== 'string' || !action.text.trim()) continue;
      const kind = action.kind === MESSAGE_KINDS.CHAT ? MESSAGE_KINDS.CHAT : MESSAGE_KINDS.TASK;
      const result = await this.dispatch({
        to: typeof action.to === 'string' && action.to.trim() ? action.to.trim() : ADDRESS_ALL,
        text: action.text,
        kind,
      });
      applied.push({ to: result.message.to, text: action.text, messageId: result.message.id });
    }

    return { say, actions: applied, mode: 'model' };
  }

  async #callModel(prompt) {
    const roster = this.panes.list().map((pane) => ({
      id: pane.id,
      label: pane.label,
      alive: pane.alive,
      pending: this.bus.pendingCount(pane.id),
    }));
    const transcript = this.bus.fullTranscript(40).map((msg) => ({
      from: msg.from,
      to: msg.to,
      kind: msg.kind,
      text: msg.text.slice(0, 1000),
    }));
    const userContent = [
      `Pane roster:\n${JSON.stringify(roster, null, 2)}`,
      `Shared transcript (most recent last):\n${JSON.stringify(transcript, null, 2)}`,
      `Human says:\n${prompt}`,
    ].join('\n\n');
    return this.#chat(SYSTEM_PROMPT, userContent);
  }

  /**
   * Decompose an objective into a validated task-graph proposal for managed
   * agents. Requires model mode; the CollaborationService re-validates every
   * field (membership, dependencies, cycles) before anything is persisted.
   *
   * @param {object} spec
   * @param {string} spec.objective
   * @param {{id:string,provider:string,label:string,permissionProfile:string,cwd:string}[]} spec.agents
   * @param {string[]|null} [spec.acceptanceCriteria] Operator criteria win over model ones.
   * @returns {Promise<{acceptanceCriteria: string[], tasks: object[]}>}
   */
  async planRun({ objective, agents, acceptanceCriteria = null }) {
    if (!this.model) {
      throw new Error('automatic planning requires the orchestrator model (CLIHIVE_BASE_URL / CLIHIVE_API_KEY / CLIHIVE_MODEL)');
    }
    if (typeof objective !== 'string' || !objective.trim()) throw new Error('planRun requires an objective');
    if (!Array.isArray(agents) || agents.length < 1) throw new Error('planRun requires at least one managed agent');

    const roster = agents.map((a) => ({
      id: a.id, provider: a.provider, label: a.label,
      permissionProfile: a.permissionProfile, cwd: a.cwd,
    }));
    const userContent = [
      `Managed agents:\n${JSON.stringify(roster, null, 2)}`,
      `Objective:\n${objective}`,
      acceptanceCriteria?.length ? `Operator-provided acceptance criteria (keep them verbatim):\n${JSON.stringify(acceptanceCriteria)}` : '',
    ].filter(Boolean).join('\n\n');

    const reply = await this.#chat(PLAN_SYSTEM_PROMPT, userContent);
    const parsed = extractJson(reply);
    if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length < 1) {
      this.tracer.emitTrace(TRACE.ORCH_ERROR, { error: 'planner returned no task graph' });
      throw new Error('planner returned no task graph');
    }
    const criteria = Array.isArray(acceptanceCriteria) && acceptanceCriteria.length
      ? acceptanceCriteria
      : (Array.isArray(parsed.acceptanceCriteria) ? parsed.acceptanceCriteria.filter((c) => typeof c === 'string' && c.trim()) : []);
    if (!criteria.length) throw new Error('planner produced no acceptance criteria');

    const tasks = parsed.tasks.slice(0, 12).map((t) => ({
      id: String(t?.id ?? ''),
      assignee: String(t?.assignee ?? ''),
      instruction: String(t?.instruction ?? ''),
      dependencies: Array.isArray(t?.dependencies) ? t.dependencies.map(String) : [],
      origin: 'planner',
    }));
    this.tracer.emitTrace(TRACE.ORCH_REPLY, { planner: true, taskCount: tasks.length, criteria: criteria.length });
    this.#note({ role: 'system', text: `Planned ${tasks.length} task(s) across ${agents.length} agent(s)` });
    return { acceptanceCriteria: criteria, tasks };
  }

  async #chat(systemPrompt, userContent) {
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('no fetch implementation available');
    }
    const body = {
      model: this.model.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.2,
    };

    const url = `${this.model.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.model.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${detail.slice(0, 300)}`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('model returned no content');
    }
    return content;
  }
}
