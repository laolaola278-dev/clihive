// Unit tests for the tracer and the orchestrator (model stubbed).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Tracer } from '../src/server/tracer.js';
import { Orchestrator, extractJson } from '../src/server/orchestrator.js';
import { MessageBus } from '../src/server/bus.js';

describe('Tracer', () => {
  it('keeps a bounded ring and assigns increasing seq', () => {
    const t = new Tracer({ file: null, ring: 100 });
    for (let i = 0; i < 150; i += 1) t.emitTrace('test.event', { i });
    assert.equal(t.ring.length, 100);
    assert.ok(t.ring[99].seq > t.ring[0].seq);
  });

  it('detail never clobbers the envelope kind', () => {
    const t = new Tracer({ file: null });
    const e = t.emitTrace('msg.send', { kind: 'chat' });
    assert.equal(e.kind, 'msg.send');
  });

  it('persists JSONL and reads it back', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clihive-tracer-'));
    const file = path.join(dir, 'trace.jsonl');
    const t = new Tracer({ file });
    t.emitTrace('a', { x: 1 });
    t.emitTrace('b', { y: 2 });
    const events = await t.readFileEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, 'a');
    assert.equal(events[1].kind, 'b');
    await rm(dir, { recursive: true, force: true });
  });

  it('strips ansi from string details', () => {
    const t = new Tracer({ file: null });
    const e = t.emitTrace('x', { line: '[2mhello[0m' });
    assert.equal(e.line, 'hello');
  });

  it('forMessage filters by messageId', () => {
    const t = new Tracer({ file: null });
    t.emitTrace('msg.send', { messageId: 'a' });
    t.emitTrace('msg.deliver', { messageId: 'a' });
    t.emitTrace('msg.deliver', { messageId: 'b' });
    assert.equal(t.forMessage('a').length, 2);
  });
});

describe('extractJson', () => {
  it('parses a clean object', () => {
    assert.deepEqual(extractJson('{"say":"hi","actions":[]}'), { say: 'hi', actions: [] });
  });
  it('finds an object inside prose', () => {
    const r = extractJson('Here you go:\n{"say":"hi"}\nthanks');
    assert.equal(r.say, 'hi');
  });
  it('handles braces inside strings', () => {
    const r = extractJson('{"say":"a } b"}');
    assert.equal(r.say, 'a } b');
  });
  it('returns null on garbage', () => {
    assert.equal(extractJson('no json here'), null);
    assert.equal(extractJson('{"broken":'), null);
  });
});

describe('Orchestrator', () => {
  function make() {
    const tracer = new Tracer({ file: null });
    const bus = new MessageBus({ tracer });
    const panes = {
      aliveIds: () => ['p1', 'p2'],
      list: () => [
        { id: 'p1', label: 'one', alive: true },
        { id: 'p2', label: 'two', alive: true },
      ],
    };
    const sinks = { p1: [], p2: [] };
    bus.registerPtySink('p1', (m) => { sinks.p1.push(m); return true; });
    bus.registerPtySink('p2', (m) => { sinks.p2.push(m); return true; });
    return { tracer, bus, panes, sinks };
  }

  it('manual mode relays to the addressed panes', async () => {
    const { bus, panes, sinks, tracer } = make();
    const orch = new Orchestrator({ bus, panes, tracer, model: null });

    const reply = await orch.ask({ text: 'do the thing', to: 'all' });
    assert.equal(reply.mode, 'manual');
    assert.equal(sinks.p1.length, 1);
    assert.equal(sinks.p2.length, 1);
    assert.ok(tracer.ring.some((e) => e.kind === 'orch.prompt'));
    assert.ok(tracer.ring.some((e) => e.kind === 'orch.action'));
  });

  it('manual mode addresses one pane', async () => {
    const { bus, panes, sinks, tracer } = make();
    const orch = new Orchestrator({ bus, panes, tracer, model: null });
    await orch.ask({ text: 'just you', to: 'p2' });
    assert.equal(sinks.p1.length, 0);
    assert.equal(sinks.p2.length, 1);
  });

  it('model mode dispatches the parsed actions', async () => {
    const { bus, panes, sinks, tracer } = make();
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"say":"deploying","actions":[{"to":"p1","kind":"task","text":"ship it"}]}' } }],
      }),
    });
    const orch = new Orchestrator({
      bus, panes, tracer, model: { baseUrl: 'http://x', apiKey: 'k', model: 'm' }, fetchImpl,
    });

    const reply = await orch.ask({ text: 'go' });
    assert.equal(reply.mode, 'model');
    assert.equal(reply.say, 'deploying');
    assert.equal(reply.actions.length, 1);
    assert.equal(sinks.p1.length, 1);
    assert.equal(sinks.p2.length, 0);
    assert.ok(tracer.ring.some((e) => e.kind === 'orch.reply'));
  });

  it('model mode survives a non-JSON reply', async () => {
    const { bus, panes, sinks, tracer } = make();
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'plain answer, no json' } }] }),
    });
    const orch = new Orchestrator({
      bus, panes, tracer, model: { baseUrl: 'http://x', apiKey: 'k', model: 'm' }, fetchImpl,
    });
    const reply = await orch.ask({ text: 'go' });
    assert.equal(reply.say, 'plain answer, no json');
    assert.equal(reply.actions.length, 0);
    assert.equal(sinks.p1.length, 0);
  });

  it('model mode reports an API failure without throwing', async () => {
    const { bus, panes, tracer } = make();
    const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'server down' });
    const orch = new Orchestrator({
      bus, panes, tracer, model: { baseUrl: 'http://x', apiKey: 'k', model: 'm' }, fetchImpl,
    });
    const reply = await orch.ask({ text: 'go' });
    assert.match(reply.say, /Model call failed/);
    assert.ok(tracer.ring.some((e) => e.kind === 'orch.error'));
  });
});
