// Trace recorder.
//
// Everything interesting that happens in the hive lands here: pane spawns,
// message fan-out, per-target delivery, acks, drops, orchestrator turns. It is
// append-only JSONL on disk plus a bounded in-memory ring the UI can replay.
//
// The trace exists to answer one question directly: "did that pane actually
// receive the message, and through which channel?"

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import { makeId, stripAnsi } from '../shared/protocol.js';

const DEFAULT_RING = 2000;
const MAX_DETAIL_CHARS = 2000;

/** Values that are safe to put in a trace line. */
function sanitizeValue(value, depth = 0) {
  if (value == null) return value ?? null;
  if (typeof value === 'string') {
    const clean = stripAnsi(value);
    return clean.length > MAX_DETAIL_CHARS ? `${clean.slice(0, MAX_DETAIL_CHARS)}...<truncated>` : clean;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (depth >= 3) return '<deep>';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, raw] of Object.entries(value).slice(0, 50)) {
      out[key] = sanitizeValue(raw, depth + 1);
    }
    return out;
  }
  return String(value);
}

export class Tracer extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string|null} [options.file] JSONL path; null disables disk writes.
   * @param {number} [options.ring] How many events to keep in memory.
   * @param {() => number} [options.now] Clock injection for tests.
   */
  constructor(options = {}) {
    super();
    this.setMaxListeners(0);
    this.file = options.file ?? null;
    this.ringSize = Math.max(50, options.ring ?? DEFAULT_RING);
    this.now = options.now ?? (() => Date.now());
    /** @type {object[]} */
    this.ring = [];
    this.seq = 0;
    this.writeErrors = 0;
    this.dirReady = false;
    /** @type {Promise<void>} */
    this.writeQueue = Promise.resolve();
  }

  /**
   * Record one event.
   * @param {string} kind One of the `TRACE.*` constants.
   * @param {Record<string, unknown>} [detail]
   * @returns {object} The stored event.
   */
  emitTrace(kind, detail = {}) {
    this.seq += 1;
    // Envelope fields go last so a detail payload can never overwrite them.
    // (A message's own `kind` -- chat/task -- must be passed as `msgKind`.)
    const event = {
      ...sanitizeValue(detail),
      seq: this.seq,
      id: makeId('tr'),
      ts: this.now(),
      kind,
    };

    this.ring.push(event);
    if (this.ring.length > this.ringSize) {
      this.ring.splice(0, this.ring.length - this.ringSize);
    }

    this.emit('trace', event);
    if (this.file) this.#persist(event);
    return event;
  }

  #persist(event) {
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        if (!this.dirReady) {
          await mkdir(path.dirname(this.file), { recursive: true });
          this.dirReady = true;
        }
        await appendFile(this.file, `${JSON.stringify(event)}\n`, 'utf8');
      } catch (err) {
        this.writeErrors += 1;
        this.emit('writeError', err);
      }
    });
  }

  /** Most recent events, oldest first. */
  recent(limit = 200) {
    const n = Math.max(0, Math.min(this.ringSize, Math.trunc(limit) || 0));
    return this.ring.slice(-n);
  }

  /** Events matching a kind prefix, e.g. `"msg."`. */
  byPrefix(prefix, limit = 200) {
    const hits = this.ring.filter((event) => event.kind.startsWith(prefix));
    return hits.slice(-Math.max(0, limit));
  }

  /** Every event tied to one message id, in order. */
  forMessage(messageId) {
    return this.ring.filter((event) => event.messageId === messageId);
  }

  /** Flush pending disk writes. */
  async drain() {
    await this.writeQueue;
  }

  /** Read the JSONL file back, skipping malformed lines. */
  async readFileEvents() {
    if (!this.file) return [];
    await this.drain();
    let raw;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A partially-written tail line is expected; skip it.
      }
    }
    return out;
  }
}
