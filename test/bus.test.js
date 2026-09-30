// Unit tests for the message bus, using in-memory sinks (no PTYs).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Tracer } from '../src/server/tracer.js';
import { MessageBus } from '../src/server/bus.js';

function makeBus() {
  const tracer = new Tracer({ file: null });
  const bus = new MessageBus({ tracer });
  return { bus, tracer };
}

describe('MessageBus.publish', () => {
  it('broadcasts to every pane except the sender', async () => {
    const { bus } = makeBus();
    const got = { p1: [], p2: [], p3: [] };
    for (const id of Object.keys(got)) {
      bus.registerPtySink(id, (msg) => { got[id].push(msg); return true; });
    }

    const { message, deliveries } = await bus.publish(
      { from: 'p1', to: 'all', text: 'hi' },
      { origin: 'test' },
    );

    assert.equal(got.p1.length, 0, 'sender must not get its own broadcast');
    assert.equal(got.p2.length, 1);
    assert.equal(got.p3.length, 1);
    assert.equal(deliveries.length, 2);
    assert.ok(deliveries.every((d) => d.ok));
    assert.ok(deliveries.every((d) => d.target !== 'p1'));
    assert.equal(message.text, 'hi');
  });

  it('delivers a direct message to exactly one pane', async () => {
    const { bus } = makeBus();
    const got = { p1: [], p2: [] };
    for (const id of Object.keys(got)) bus.registerPtySink(id, (m) => { got[id].push(m); return true; });

    const { deliveries } = await bus.publish({ from: 'p1', to: 'p2', text: 'secret' }, {});
    assert.equal(got.p2.length, 1);
    assert.equal(got.p1.length, 0);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].target, 'p2');
  });

  it('drops a message to an unknown target and records why', async () => {
    const { bus, tracer } = makeBus();
    bus.registerPtySink('p1', () => true);
    const { deliveries } = await bus.publish({ from: 'p1', to: 'ghost', text: 'x' }, {});
    assert.equal(deliveries[0].ok, false);
    assert.equal(deliveries[0].reason, 'unknown-target');
    assert.ok(tracer.ring.some((e) => e.kind === 'msg.drop' && e.target === 'ghost'));
  });

  it('records a sink failure as a drop with the reason', async () => {
    const { bus } = makeBus();
    bus.registerPtySink('p1', () => true);
    bus.registerPtySink('p2', () => { throw new Error('boom'); });

    const { deliveries } = await bus.publish({ from: 'p1', to: 'p2', text: 'x' }, {});
    assert.equal(deliveries[0].ok, false);
    assert.match(deliveries[0].reason, /sink-error: boom/);
  });

  it('honours a rich sink result channel', async () => {
    const { bus } = makeBus();
    bus.registerPtySink('p1', () => true);
    bus.registerPtySink('p2', () => ({ ok: true, channel: 'display' }));

    const { deliveries } = await bus.publish({ from: 'p1', to: 'p2', text: 'x' }, {});
    assert.equal(deliveries[0].channel, 'display');
    assert.equal(deliveries[0].ok, true);
  });
});

describe('MessageBus transcript + visibility', () => {
  it('a pane sees peer chatter but not another pane private orchestrator note', async () => {
    const { bus } = makeBus();
    bus.registerPtySink('p1', () => true);
    bus.registerPtySink('p2', () => true);

    await bus.publish({ from: 'p1', to: 'all', text: 'to everyone' }, {});
    await bus.publish({ from: 'orchestrator', to: 'p2', kind: 'task', text: 'just for p2' }, {});

    const p1View = bus.transcriptFor('p1').map((m) => m.text);
    const p2View = bus.transcriptFor('p2').map((m) => m.text);

    assert.ok(p1View.includes('to everyone'));
    assert.ok(!p1View.includes('just for p2'), 'private note hidden from p1');
    assert.ok(p2View.includes('just for p2'), 'p2 sees its own instruction');
  });
});

describe('MessageBus inbox / ack', () => {
  it('queues for pull, drains on inbox, and acknowledges', async () => {
    const { bus, tracer } = makeBus();
    bus.registerPtySink('p1', () => true);

    const { message } = await bus.publish({ from: 'p2', to: 'p1', text: 'hello p1' }, {});
    assert.equal(bus.pendingCount('p1'), 1);

    const peek = bus.drainInbox('p1', { peek: true });
    assert.equal(peek.length, 1);
    assert.equal(bus.pendingCount('p1'), 1, 'peek must not drain');

    const drained = bus.drainInbox('p1');
    assert.equal(drained.length, 1);
    assert.equal(drained[0].id, message.id);
    assert.equal(bus.pendingCount('p1'), 0);

    const report = bus.deliveryReport(message.id);
    const t = report.targets.find((x) => x.target === 'p1');
    assert.ok(t.acked, 'draining the inbox acknowledges the message');
    assert.ok(tracer.ring.some((e) => e.kind === 'msg.ack' && e.target === 'p1'));
  });
});

describe('MessageBus.unregisterPane', () => {
  it('drops queued messages and traces the drop', async () => {
    const { bus, tracer } = makeBus();
    bus.registerPtySink('p1', () => true);
    await bus.publish({ from: 'p2', to: 'p1', text: 'x' }, {});
    assert.equal(bus.pendingCount('p1'), 1);

    bus.unregisterPane('p1');
    assert.equal(bus.pendingCount('p1'), 0);
    assert.ok(tracer.ring.some((e) => e.kind === 'msg.drop' && e.reason === 'pane-gone'));
  });
});
