// Plugin system tests: collection configuration shared by every managed CLI.
//
// Covers: plugin validation, registry load/save/remove, provider filtering
// (leading CLI vs multi-CLI adaptation), prompt injection (skills, agent
// prompt), local history injection, continueRun, and the HTTP routes.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { validatePlugin, pluginsForTurn, PluginRegistry } from '../src/server/plugins.js';
import { buildTurnPrompt } from '../src/server/agent-runtime/turn-prompt.js';
import { CollaborationStore } from '../src/server/collaboration-store.js';
import { CollaborationService } from '../src/server/collaboration-service.js';
import { HiveServer } from '../src/server/http.js';

const agent = { id: 'agt-1', label: 'Worker', provider: 'codex' };
const run = { id: 'run-1', objective: 'ship the feature', acceptanceCriteria: ['all green'] };
const baseTask = { id: 't1', instruction: 'do the thing', cwd: '/tmp', dependencies: [] };
const peers = [{ id: 'agt-2', label: 'Peer', provider: 'claude' }];

const doneResult = (over = {}) => ({
  summary: 'work complete', outcome: 'done', artifacts: [], checks: [],
  messages: [], followUps: [], question: null, ...over,
});

describe('plugin validation', () => {
  it('accepts a minimal plugin and normalizes it', () => {
    const p = validatePlugin({ name: 'review-buddy', version: '1.0.0' });
    assert.equal(p.name, 'review-buddy');
    assert.equal(p.skills.length, 0);
    assert.equal(p.agentPrompt, null);
    assert.equal(p.historyTurns, 0);
    assert.deepEqual(p.providers, []);
  });

  it('accepts a full plugin', () => {
    const p = validatePlugin({
      name: 'full', version: '2.3.1',
      description: 'everything at once',
      skills: [{ name: 'triage', prompt: 'Triage the backlog first.' }],
      agentPrompt: 'Prefer small diffs.',
      historyTurns: 5,
      providers: ['codex', 'claude'],
    });
    assert.equal(p.skills[0].name, 'triage');
    assert.equal(p.historyTurns, 5);
    assert.deepEqual(p.providers, ['codex', 'claude']);
  });

  it('rejects unknown fields, bad names, dup skills, bad providers', () => {
    assert.throws(() => validatePlugin({ name: 'x', version: '1.0.0', oops: 1 }), /unknown plugin field/);
    assert.throws(() => validatePlugin({ name: 'Bad Name', version: '1.0.0' }), /plugin.name/);
    assert.throws(() => validatePlugin({ name: 'ok', version: 'not-semver' }), /plugin.version/);
    assert.throws(() => validatePlugin({
      name: 'ok', version: '1.0.0',
      skills: [{ name: 'a', prompt: 'x' }, { name: 'a', prompt: 'y' }],
    }), /duplicate skill name/);
    assert.throws(() => validatePlugin({ name: 'ok', version: '1.0.0', providers: ['gemini'] }), /providers supports only/);
    assert.throws(() => validatePlugin({ name: 'ok', version: '1.0.0', historyTurns: 99 }), /historyTurns/);
  });
});

describe('pluginsForTurn (provider adaptation)', () => {
  const all = validatePlugin({
    name: 'shared', version: '1.0.0',
    skills: [{ name: 'common-skill', prompt: 'applies to every CLI' }],
    agentPrompt: 'Be terse.',
    historyTurns: 3,
  });
  const codexOnly = validatePlugin({
    name: 'codex-extra', version: '1.0.0',
    skills: [{ name: 'codex-skill', prompt: 'codex only' }],
    providers: ['codex'],
  });
  const claudeOnly = validatePlugin({
    name: 'claude-extra', version: '1.0.0',
    agentPrompt: 'Claude house style.',
    providers: ['claude'],
  });
  const set = [all, codexOnly, claudeOnly];

  it('an empty providers filter reaches every CLI (leading + multi-CLI)', () => {
    const forCodex = pluginsForTurn(set, { provider: 'codex' });
    const forClaude = pluginsForTurn(set, { provider: 'claude' });
    const forOpencode = pluginsForTurn(set, { provider: 'opencode' });
    assert.ok(forCodex.skills.some((s) => s.name === 'common-skill'));
    assert.ok(forClaude.skills.some((s) => s.name === 'common-skill'));
    assert.ok(forOpencode.skills.some((s) => s.name === 'common-skill'));
    assert.ok(forCodex.skills.some((s) => s.name === 'codex-skill'));
    assert.ok(!forClaude.skills.some((s) => s.name === 'codex-skill'));
    assert.ok(!forOpencode.skills.some((s) => s.name === 'codex-skill'));
  });

  it('provider-scoped agentPrompt only applies to that provider', () => {
    assert.match(pluginsForTurn(set, { provider: 'claude' }).agentPrompt, /Be terse\.\n\nClaude house style\./);
    assert.equal(pluginsForTurn(set, { provider: 'opencode' }).agentPrompt, 'Be terse.');
  });

  it('historyTurns is the max across applicable plugins', () => {
    assert.equal(pluginsForTurn(set, { provider: 'codex' }).historyTurns, 3);
  });
});

describe('PluginRegistry', () => {
  let dir;
  let registry;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'clihive-plugins-'));
    registry = new PluginRegistry(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads from a directory, sorted and validated', async () => {
    await writeFile(path.join(dir, 'b-second.json'), JSON.stringify({ name: 'b-second', version: '1.0.0' }));
    await writeFile(path.join(dir, 'a-first.json'), JSON.stringify({ name: 'a-first', version: '0.9.0' }));
    const plugins = await registry.load();
    assert.deepEqual(plugins.map((p) => p.name), ['a-first', 'b-second']);
  });

  it('save + get + remove round-trip', async () => {
    const saved = await registry.save({ name: 'round-trip', version: '1.2.3', skills: [{ name: 's', prompt: 'p' }] });
    assert.equal(saved.version, '1.2.3');
    const got = await registry.get('round-trip');
    assert.equal(got.skills[0].prompt, 'p');
    assert.ok(await registry.remove('round-trip'));
    assert.equal(await registry.get('round-trip'), null);
    await assert.rejects(() => registry.remove('round-trip'), /unknown plugin/);
  });

  it('rejects malformed plugin files at load (fail closed)', async () => {
    await writeFile(path.join(dir, 'broken.json'), JSON.stringify({ name: 'broken', version: 'oops' }));
    await assert.rejects(() => registry.load(), /plugin.version/);
  });

  it('rejects path-tricky plugin names', async () => {
    await assert.rejects(() => registry.remove('..%2Fescape'), /invalid plugin name/);
  });
});

describe('turn prompt injection', () => {
  it('skills, plugin prompt, and history land in the built prompt', () => {
    const prompt = buildTurnPrompt({
      agent, run, task: baseTask, permissionProfile: 'read-only', peers,
      skills: [{ name: 'triage', prompt: 'Triage first.', plugin: 'review-buddy' }],
      pluginPrompt: 'Prefer small diffs.',
      history: [{ taskId: 't0', instruction: 'old task', outcome: 'done', summary: 'shipped v1' }],
    });
    assert.match(prompt, /## Skills \(from the active plugin set\)/);
    assert.match(prompt, /\*\*triage\*\* \(plugin `review-buddy`\): Triage first\./);
    assert.match(prompt, /## Additional guidance \(from the active plugin set\)/);
    assert.match(prompt, /Prefer small diffs\./);
    assert.match(prompt, /## Your own recent history in this hive/);
    assert.match(prompt, /task `t0` \[done\]: old task/);
    assert.match(prompt, /shipped v1/);
  });

  it('omits the sections entirely when no plugin material exists', () => {
    const prompt = buildTurnPrompt({ agent, run, task: baseTask, permissionProfile: 'read-only', peers });
    assert.ok(!prompt.includes('Skills (from the active plugin set)'));
    assert.ok(!prompt.includes('Additional guidance'));
    assert.ok(!prompt.includes('own recent history'));
  });
});

describe('CollaborationService + plugins + history', () => {
  let dir;
  let store;
  let turns;
  let service;
  let idCounter;
  const ids = (prefix) => `${prefix}-${String(++idCounter).padStart(4, '0')}`;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'clihive-svc-plug-'));
    store = await CollaborationStore.open(dir);
    const calls = [];
    const impl = (adapter, options) => new Promise((resolve) => {
      calls.push({ adapter, options, prompt: options.prompt, resolve, child: null });
      if (options.onSpawn) {
        const child = { pid: 777, exitCode: null, kill: () => {} };
        calls[calls.length - 1].child = child;
        options.onSpawn(child);
      }
    });
    turns = { impl, calls };
    idCounter = 0;
    service = new CollaborationService({
      store,
      ids,
      plugins: [validatePlugin({
        name: 'shared', version: '1.0.0',
        skills: [{ name: 'common', prompt: 'always be closing' }],
        historyTurns: 3,
      })],
      resolveExecutable: async (name) => ({ command: `fake-${name}`, prependArgs: [], resolvedFrom: 'test' }),
      detect: async () => ({ available: true, version: 'fake-1.0' }),
      runTurnImpl: turns.impl,
      killTree: (child) => child?.kill?.(),
      baseEnv: { PATH: '/usr/bin' },
    });
    await service.init();
  });

  afterEach(async () => {
    await service.close();
    await new Promise((r) => setTimeout(r, 40));
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function completeFirstTask() {
    const codex = await service.registerAgent({ provider: 'codex', cwd: dir });
    await service.createRun(
      { objective: 'first feature', agentIds: [codex.id], acceptanceCriteria: ['c1'], permissionProfile: 'read-only' },
      [{ id: 'first-1', assignee: codex.id, instruction: 'implement first', dependencies: [] }],
    );
    await new Promise((r) => setTimeout(r, 60));
    const call = turns.calls.find((c) => c.prompt.includes('implement first'));
    assert.ok(call, 'first turn dispatched');
    call.resolve({
      ok: true, sessionId: 's1', rawResult: doneResult({ summary: 'first done' }),
      error: null, exitCode: 0, timedOut: false, spawnError: null, stderrTail: '',
      attemptId: 'att-1',
    });
    await new Promise((r) => setTimeout(r, 120));
    const task = service.task('first-1');
    assert.equal(task.state, 'awaiting_review', `task state: ${task.state} (${task.error ?? ''})`);
    return codex;
  }

  it('plugin skills are injected into a real dispatched prompt', async () => {
    const codex = await completeFirstTask();
    const call = turns.calls.find((c) => c.prompt.includes('implement first'));
    assert.match(call.prompt, /always be closing/);
    assert.match(call.prompt, /## Skills \(from the active plugin set\)/);
    assert.ok(codex);
  });

  it('historyTurns feeds the agent its own completed results', async () => {
    const codex = await completeFirstTask();
    const current = service.task('first-1');
    await service.reviewTask('first-1', { approved: true, evidence: 'checked output', expectedRevision: current.revision });
    await service.createRun(
      { objective: 'second feature', agentIds: [codex.id], acceptanceCriteria: ['c2'], permissionProfile: 'read-only' },
      [{ id: 'second-1', assignee: codex.id, instruction: 'implement second', dependencies: [] }],
    );
    await new Promise((r) => setTimeout(r, 80));
    const call = turns.calls.find((c) => c.prompt.includes('implement second'));
    assert.ok(call, 'second turn dispatched');
    assert.match(call.prompt, /first done/);
    assert.match(call.prompt, /## Your own recent history in this hive/);
  });

  it('continueRun seeds a new run with the old run\u2019s completed results', async () => {
    const codex = await completeFirstTask();
    const current = service.task('first-1');
    await service.reviewTask('first-1', { approved: true, evidence: 'verified', expectedRevision: current.revision });
    const oldRunId = service.listRuns().at(-1).id;
    const run = await service.continueRun(
      oldRunId,
      { objective: 'keep going', agentIds: [codex.id], acceptanceCriteria: ['c3'], permissionProfile: 'read-only' },
      [{ id: 'next-1', assignee: codex.id, instruction: 'implement next', dependencies: [] }],
    );
    assert.notEqual(run.id, oldRunId);
    await new Promise((r) => setTimeout(r, 80));
    const call = turns.calls.find((c) => c.prompt.includes('implement next'));
    assert.ok(call, 'continued turn dispatched');
    assert.match(call.prompt, /## Prior work this run continues/);
    assert.match(call.prompt, /first done/);
  });

  it('continueRun refuses a run with nothing completed', async () => {
    const codex = await service.registerAgent({ provider: 'codex', cwd: dir });
    const run = await service.createRun(
      { objective: 'empty', agentIds: [codex.id], acceptanceCriteria: ['c'], permissionProfile: 'read-only' },
      [{ id: 'never-1', assignee: codex.id, instruction: 'will not run', dependencies: [] }],
    );
    // run-0001 has no completed tasks; the empty run we just made does not either.
    await assert.rejects(
      () => service.continueRun(run.id, { objective: 'x', agentIds: [codex.id], acceptanceCriteria: ['c'] }, []),
      /no completed tasks/,
    );
  });
});

describe('plugin HTTP API', () => {
  let home;
  let server;
  let url;
  let token;

  const api = async (route, { method = 'GET', body } = {}) => {
    const res = await fetch(`${url}/api/${route}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(body ? { authorization: `Bearer ${token}` } : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'clihive-plug-api-'));
    server = new HiveServer({
      rootDir: process.cwd(),
      port: 0,
      writeToken: false,
      tracePath: path.join(home, 'trace.jsonl'),
      collabDir: path.join(home, 'collab'),
      pluginsDir: path.join(home, 'plugins'),
      collaboration: {
        resolveExecutable: async (name) => ({ command: `fake-${name}`, prependArgs: [], resolvedFrom: 'test' }),
        detect: async () => ({ available: true, version: 'fake-1.0' }),
        runTurnImpl: () => new Promise(() => {}), // never resolves; not exercised here
        killTree: () => {},
      },
    });
    ({ url, token } = await server.listen());
  });

  afterEach(async () => {
    await server.close();
    await new Promise((r) => setTimeout(r, 40));
    await rm(home, { recursive: true, force: true });
  });

  it('lists an empty plugin set with its directory', async () => {
    const res = await api('plugins');
    assert.equal(res.status, 200);
    assert.equal(res.json.plugins.length, 0);
    assert.match(res.json.pluginsDir, /plugins/);
  });

  it('installs, lists, shows, and removes a plugin through the API', async () => {
    const add = await api('plugins', {
      method: 'POST',
      body: {
        name: 'triage-kit', version: '1.4.0', description: 'triage everywhere',
        skills: [{ name: 'triage', prompt: 'Triage before coding.' }],
        historyTurns: 2,
      },
    });
    assert.equal(add.status, 201);
    assert.equal(add.json.plugin.name, 'triage-kit');

    const list = await api('plugins');
    assert.equal(list.json.plugins.length, 1);
    assert.deepEqual(list.json.plugins[0].skills, ['triage']);
    assert.equal(list.json.plugins[0].historyTurns, 2);

    const show = await api('plugins/triage-kit');
    assert.equal(show.status, 200);
    assert.equal(show.json.plugin.skills[0].prompt, 'Triage before coding.');

    // The installed set is live on the collaboration service immediately.
    assert.equal(server.collaboration.plugins.length, 1);

    const del = await api('plugins/triage-kit', { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(del.json.plugins, 0);
    assert.equal(server.collaboration.plugins.length, 0);

    const gone = await api('plugins/triage-kit');
    assert.equal(gone.status, 404);
  });

  it('rejects an invalid plugin with 400 and persists nothing', async () => {
    const bad = await api('plugins', { method: 'POST', body: { name: 'nope', version: 'bad' } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /plugin.version/);
    const list = await api('plugins');
    assert.equal(list.json.plugins.length, 0);
  });

  it('rejects unauthenticated plugin writes', async () => {
    const res = await fetch(`${url}/api/plugins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', version: '1.0.0' }),
    });
    assert.equal(res.status, 401);
  });
});
