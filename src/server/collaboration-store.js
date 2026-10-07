// Durable collaboration transactions. Unlike the UI trace, a malformed journal
// is fatal: silently skipping a task event could repeat external side effects.
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CollaborationError, entityId, objectFields, requireRevision } from './collaboration-validation.js';

const TABLES = ['agents', 'runs', 'tasks', 'messages', 'receipts', 'idempotency'];
const MAX_TRANSACTION_BYTES = 2 * 1024 * 1024;
const fresh = () => ({ seq: 0, tables: Object.fromEntries(TABLES.map((name) => [name, {}])) });
const clone = (value) => structuredClone(value);
const digest = (text) => createHash('sha256').update(text).digest('hex');
const failure = (message) => new CollaborationError(message, 503, 'STORE_UNAVAILABLE');

// Strict round-trip validation prevents undefined, NaN, accessors, and prototype
// keys from changing meaning between the in-memory state and its journal.
function jsonValue(value, depth = 0) {
  if (depth > 40) throw new CollaborationError('Stored value is too deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (!Object.hasOwn(value, i)) throw new CollaborationError('Sparse arrays are not supported');
      jsonValue(value[i], depth + 1);
    }
    return;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || !Object.hasOwn(descriptor, 'value')) {
        throw new CollaborationError('Unsafe stored property');
      }
      jsonValue(descriptor.value, depth + 1);
    }
    return;
  }
  throw new CollaborationError('Stored values must be plain JSON');
}

function apply(state, transaction) {
  objectFields(transaction, ['version', 'seq', 'id', 'ts', 'operations'], 'transaction');
  if (transaction.version !== 1 || transaction.seq !== state.seq + 1
      || typeof transaction.id !== 'string' || !Number.isSafeInteger(transaction.ts)
      || !Array.isArray(transaction.operations) || transaction.operations.length < 1
      || transaction.operations.length > 256) throw failure('Invalid journal transaction');
  const next = clone(state);
  const touched = new Set();
  for (const op of transaction.operations) {
    objectFields(op, ['table', 'id', 'expectedRevision', 'value'], 'operation');
    if (!TABLES.includes(op.table)) throw new CollaborationError('Unknown collaboration table');
    entityId(op.id);
    if (['__proto__', 'prototype', 'constructor'].includes(op.id)) throw new CollaborationError('Unsafe entity ID');
    const key = `${op.table}/${op.id}`;
    if (touched.has(key)) throw new CollaborationError('An entity may be changed only once per transaction');
    touched.add(key);
    const current = Object.hasOwn(next.tables[op.table], op.id) ? next.tables[op.table][op.id] : null;
    if (current) requireRevision(current.revision, op.expectedRevision);
    else if (op.expectedRevision !== 0) throw new CollaborationError('Creation requires revision 0', 409, 'REVISION_CONFLICT');
    if (!op.value || Array.isArray(op.value) || typeof op.value !== 'object') {
      throw new CollaborationError('Entity value must be an object; use a tombstone instead of deleting');
    }
    if (Object.hasOwn(op.value, 'id') || Object.hasOwn(op.value, 'revision')) {
      throw new CollaborationError('Entity ID and revision are assigned by the store');
    }
    next.tables[op.table][op.id] = { ...clone(op.value), id: op.id, revision: (current?.revision ?? 0) + 1 };
  }
  next.seq = transaction.seq;
  return next;
}

export class CollaborationStore {
  #state = fresh();
  #queue = Promise.resolve();
  #journal;
  #lock;
  #closed = false;
  #poisoned = false;

  static async open(directory) {
    const store = new CollaborationStore();
    store.directory = path.resolve(directory);
    store.journalPath = path.join(store.directory, 'events.jsonl');
    store.lockPath = path.join(store.directory, 'writer.lock');
    await mkdir(store.directory, { recursive: true });
    try {
      store.#lock = await open(store.lockPath, 'wx', 0o600);
    } catch (err) {
      if (err.code === 'EEXIST') throw failure('Collaboration writer lock exists. Verify the previous process has stopped before recovering; never remove an active lock.');
      throw err;
    }
    try {
      await store.#lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      await store.#lock.sync();
      let bytes;
      try { bytes = await readFile(store.journalPath); }
      catch (err) { if (err.code !== 'ENOENT') throw err; bytes = Buffer.alloc(0); }
      if (bytes.length && bytes[bytes.length - 1] !== 10) {
        throw failure('Journal has an incomplete tail. Preserve it for explicit recovery; automatic execution is disabled.');
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      for (const line of text.split('\n').slice(0, -1)) {
        if (!line || Buffer.byteLength(line) > MAX_TRANSACTION_BYTES) throw failure('Invalid journal record size');
        const record = JSON.parse(line);
        objectFields(record, ['payload', 'sha256'], 'journal record');
        if (typeof record.payload !== 'string' || digest(record.payload) !== record.sha256) {
          throw failure('Journal checksum mismatch');
        }
        const transaction = JSON.parse(record.payload);
        jsonValue(transaction);
        store.#state = apply(store.#state, transaction);
      }
      // The journal is authoritative. Snapshots are derived checkpoints only;
      // replaying it also validates records preceding the latest checkpoint.
      store.#journal = await open(store.journalPath, 'a', 0o600);
      return store;
    } catch (err) {
      await store.#lock.close().catch(() => {});
      await unlink(store.lockPath).catch(() => {});
      throw failure(`Cannot open collaboration store: ${err.message}`);
    }
  }

  snapshot() { return clone(this.#state); }
  get(table, id) {
    if (!TABLES.includes(table)) throw new CollaborationError('Unknown collaboration table');
    return Object.hasOwn(this.#state.tables[table], id) ? clone(this.#state.tables[table][id]) : null;
  }
  list(table) {
    if (!TABLES.includes(table)) throw new CollaborationError('Unknown collaboration table');
    return Object.values(clone(this.#state.tables[table]));
  }

  #enqueue(work) {
    if (this.#closed) return Promise.reject(failure('Store is closed'));
    const pending = this.#queue.then(() => {
      if (this.#poisoned) throw failure('A persistence failure requires store recovery before more writes');
      return work();
    });
    this.#queue = pending.catch(() => {});
    return pending;
  }

  // A synchronous builder sees the latest state while holding the write queue.
  // It must perform no external effects. [] is a read-only/idempotent no-op.
  transact(builder) {
    return this.#enqueue(async () => {
      const operations = builder(clone(this.#state));
      if (!Array.isArray(operations)) throw new CollaborationError('Transaction builder must synchronously return operations');
      if (!operations.length) return this.snapshot();
      const transaction = { version: 1, seq: this.#state.seq + 1, id: randomUUID(), ts: Date.now(), operations };
      jsonValue(transaction);
      const next = apply(this.#state, transaction);
      const payload = JSON.stringify(transaction);
      const encoded = `${JSON.stringify({ payload, sha256: digest(payload) })}\n`;
      if (Buffer.byteLength(encoded) > MAX_TRANSACTION_BYTES) throw new CollaborationError('Transaction exceeds storage limit');
      try {
        await this.#journal.writeFile(encoded, 'utf8');
        await this.#journal.sync();
      } catch (err) {
        // A partial append or failed fsync has an uncertain commit outcome.
        // Fail closed rather than letting a retry perform an external action.
        this.#poisoned = true;
        throw failure(`Journal write failed; commit outcome is uncertain: ${err.message}`);
      }
      this.#state = next;
      return this.snapshot();
    });
  }

  checkpoint() {
    return this.#enqueue(async () => {
      const target = path.join(this.directory, 'snapshot.json');
      const temporary = path.join(this.directory, `snapshot-${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ version: 1, state: this.#state }), 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temporary, target);
      } finally {
        if (handle) await handle.close().catch(() => {});
        await unlink(temporary).catch((err) => { if (err.code !== 'ENOENT') throw err; });
      }
    });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#queue;
    try { await this.#journal?.close(); }
    finally {
      await this.#lock?.close();
      await unlink(this.lockPath);
    }
  }
}
