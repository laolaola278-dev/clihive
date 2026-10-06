// The message bus.
//
// This is the heart of the hive. Panes talk to each other, to the orchestrator,
// and to the human through here. The bus does four things:
//
//   1. keeps the shared transcript every pane can read,
//   2. fans a message out to its real targets,
//   3. delivers to each target and records the outcome per target,
//   4. tracks acks, so "did pane 3 get it?" has a factual answer.
//
// Delivery is intentionally two-track. A pane gets the message pushed (painted
// into its viewport, channel `display`, or written to its stdin, channel `pty`)
// AND can pull it later with `hive inbox` (channel `cli`). The pull is the
// acknowledgement: it is what proves an agent actually read the message, even
// if it was mid-turn when the push landed.

import { EventEmitter } from 'node:events';

import {
  ADDRESS_ALL,
  ADDRESS_HUMAN,
  ADDRESS_ORCHESTRATOR,
  DELIVERY_CHANNELS,
  TRACE,
  isVisibleTo,
  makeId,
  normalizeMessage,
  resolveTargets,
} from '../shared/protocol.js';

const DEFAULT_HISTORY = 1000;

export class MessageBus extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('./tracer.js').Tracer} deps.tracer
   * @param {number} [deps.history] Shared transcript cap.
   * @param {() => number} [deps.now]
   */
  constructor({ tracer, history = DEFAULT_HISTORY, now } = {}) {
    super();
    this.setMaxListeners(0);
    if (!tracer) throw new Error('MessageBus requires a tracer');
    this.tracer = tracer;
    this.historySize = Math.max(50, history);
    this.now = now ?? (() => Date.now());

    /** @type {object[]} Shared transcript, oldest first. */
    this.transcript = [];
    /** @type {Map<string, object>} messageId -> message */
    this.byId = new Map();
    /** @type {Map<string, object[]>} messageId -> delivery records */
    this.deliveries = new Map();
    /** @type {Map<string, object[]>} paneId -> undelivered pull queue */
    this.pending = new Map();
    /** @type {Map<string, (msg: object, target: string) => Promise<boolean>|boolean>} */
    this.ptySinks = new Map();
  }

  /**
   * Register how to push a message into a pane's stdin.
   * @param {string} paneId
   * @param {(msg: object, paneId: string) => Promise<boolean>|boolean} sink
   */
  registerPtySink(paneId, sink) {
    this.ptySinks.set(paneId, sink);
    if (!this.pending.has(paneId)) this.pending.set(paneId, []);
  }

  /** Forget a pane. Its unread queue is dropped and the drop is traced. */
  unregisterPane(paneId) {
    this.ptySinks.delete(paneId);
    const queued = this.pending.get(paneId) ?? [];
    for (const item of queued) {
      this.tracer.emitTrace(TRACE.MSG_DROP, {
        messageId: item.messageId,
        target: paneId,
        reason: 'pane-gone',
      });
    }
    this.pending.delete(paneId);
  }

  /** Pane ids that currently have a stdin sink. */
  knownPanes() {
    return [...this.ptySinks.keys()];
  }

  /**
   * Publish a message and deliver it.
   *
   * @param {Record<string, unknown>} input Raw, untrusted payload.
   * @param {object} [ctx]
   * @param {string} [ctx.origin] How it entered: `cli`, `panel`, `ws`, `system`.
   * @param {Iterable<string>} [ctx.paneIds] Override the target universe.
   * @returns {Promise<{message: object, deliveries: object[]}>}
   */
  async publish(input, ctx = {}) {
    const message = normalizeMessage({ ...input, ts: input.ts ?? this.now() });
    const origin = typeof ctx.origin === 'string' ? ctx.origin : 'unknown';

    this.#record(message);
    this.tracer.emitTrace(TRACE.MSG_SEND, {
      messageId: message.id,
      from: message.from,
      to: message.to,
      msgKind: message.kind,
      origin,
      chars: message.text.length,
    });

    const universe = ctx.paneIds ? [...ctx.paneIds] : this.knownPanes();
    const targets = resolveTargets(message, universe);

    this.tracer.emitTrace(TRACE.MSG_FANOUT, {
      messageId: message.id,
      to: message.to,
      targets,
      targetCount: targets.length,
    });

    this.emit('message', message);

    if (targets.length === 0) {
      const record = {
        messageId: message.id,
        target: message.to,
        channel: null,
        ok: false,
        ts: this.now(),
        reason: message.to === ADDRESS_ALL ? 'no-other-panes' : 'unknown-target',
      };
      this.#addDelivery(record);
      this.tracer.emitTrace(TRACE.MSG_DROP, record);
      this.emit('delivery', record);
      return { message, deliveries: [record] };
    }

    const records = [];
    for (const target of targets) {
      records.push(await this.#deliver(message, target));
    }
    return { message, deliveries: records };
  }

  async #deliver(message, target) {
    if (target === ADDRESS_ORCHESTRATOR || target === ADDRESS_HUMAN) {
      const record = {
        messageId: message.id,
        target,
        channel: DELIVERY_CHANNELS.PANEL,
        ok: true,
        ts: this.now(),
        reason: null,
      };
      this.#addDelivery(record);
      this.tracer.emitTrace(TRACE.MSG_DELIVER, record);
      this.emit('delivery', record);
      return record;
    }

    // Queue for the pull track first, so a `hive inbox` call can still find the
    // message even if the stdin push fails or the agent ignores it.
    const queue = this.pending.get(target) ?? [];
    const pendingEntry = {
      messageId: message.id,
      queuedAt: this.now(),
      pushed: false,
    };
    queue.push(pendingEntry);
    this.pending.set(target, queue);

    const sink = this.ptySinks.get(target);
    let ok = false;
    let reason = null;
    let held = false;
    let channel = DELIVERY_CHANNELS.DISPLAY;

    if (!sink) {
      ok = false;
      reason = 'no-sink';
      channel = null;
    } else {
      try {
        const result = await sink(message, target);
        // A sink may answer with a boolean or with `{ ok, channel, reason }`.
        if (result && typeof result === 'object') {
          ok = result.ok !== false;
          channel = result.channel ?? channel;
          reason = result.reason ?? null;
          held = result.held === true;
        } else {
          ok = result !== false;
        }
        if (!ok && !reason) reason = 'sink-refused';
      } catch (err) {
        ok = false;
        reason = `sink-error: ${err?.message ?? String(err)}`;
      }
    }

    pendingEntry.pushed = ok;

    const record = {
      messageId: message.id,
      target,
      channel,
      ok,
      ts: this.now(),
      reason,
    };
    // Only recorded when true, so a normal delivery stays as lean as before.
    if (held) record.held = true;
    this.#addDelivery(record);
    this.tracer.emitTrace(ok ? TRACE.MSG_DELIVER : TRACE.MSG_DROP, record);
    this.emit('delivery', record);
    return record;
  }

  #record(message) {
    this.transcript.push(message);
    this.byId.set(message.id, message);
    if (this.transcript.length > this.historySize) {
      const evicted = this.transcript.splice(0, this.transcript.length - this.historySize);
      for (const old of evicted) {
        this.byId.delete(old.id);
        this.deliveries.delete(old.id);
      }
    }
  }

  #addDelivery(record) {
    const list = this.deliveries.get(record.messageId) ?? [];
    list.push(record);
    this.deliveries.set(record.messageId, list);
  }

  /**
   * Drain a pane's pull queue. This is what `hive inbox` calls, and it is also
   * the explicit acknowledgement that the pane saw those messages.
   *
   * @param {string} paneId
   * @param {object} [opts]
   * @param {boolean} [opts.peek] Read without acknowledging.
   * @returns {object[]} Full message objects, oldest first.
   */
  drainInbox(paneId, opts = {}) {
    const queue = this.pending.get(paneId) ?? [];
    const messages = queue
      .map((entry) => this.byId.get(entry.messageId))
      .filter(Boolean);

    if (opts.peek) return messages;

    for (const entry of queue) {
      this.tracer.emitTrace(TRACE.MSG_ACK, {
        messageId: entry.messageId,
        target: paneId,
        channel: DELIVERY_CHANNELS.CLI,
        waitedMs: this.now() - entry.queuedAt,
        pushed: entry.pushed,
      });
      const record = {
        messageId: entry.messageId,
        target: paneId,
        channel: DELIVERY_CHANNELS.CLI,
        ok: true,
        ts: this.now(),
        reason: 'acked',
      };
      this.#addDelivery(record);
      this.emit('delivery', record);
    }
    this.pending.set(paneId, []);
    return messages;
  }

  /** How many messages are waiting in a pane's pull queue. */
  pendingCount(paneId) {
    return (this.pending.get(paneId) ?? []).length;
  }

  /**
   * The shared transcript as one pane sees it. Every pane sees peer chatter;
   * private orchestrator instructions to another pane are filtered out.
   *
   * @param {string} paneId
   * @param {number} [limit]
   */
  transcriptFor(paneId, limit = 100) {
    const visible = this.transcript.filter((msg) => isVisibleTo(msg, paneId));
    return visible.slice(-Math.max(0, limit));
  }

  /** The full transcript, for the orchestrator panel and the human. */
  fullTranscript(limit = 200) {
    return this.transcript.slice(-Math.max(0, limit));
  }

  /**
   * Delivery report for one message: who was targeted, through which channel,
   * whether it landed, and whether it was acknowledged.
   * @param {string} messageId
   */
  deliveryReport(messageId) {
    const message = this.byId.get(messageId) ?? null;
    const records = this.deliveries.get(messageId) ?? [];
    const byTarget = new Map();
    for (const record of records) {
      const current = byTarget.get(record.target) ?? {
        target: record.target,
        pushed: false,
        acked: false,
        channels: [],
        reason: null,
      };
      if (record.channel) current.channels.push(record.channel);
      if (record.channel === DELIVERY_CHANNELS.CLI && record.ok) current.acked = true;
      else if (record.ok && record.channel) current.pushed = true;
      if (!record.ok && record.reason) current.reason = record.reason;
      byTarget.set(record.target, current);
    }
    return { message, records, targets: [...byTarget.values()] };
  }

  /**
   * Convenience: publish a system notice from the hive itself.
   * @param {string} text
   * @param {string} [to]
   */
  async system(text, to = ADDRESS_ALL) {
    return this.publish(
      { id: makeId('msg'), from: 'hive', to, kind: 'system', text },
      { origin: 'system' },
    );
  }
}
