import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, appendFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CollaborationStore } from '../src/server/collaboration-store.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clihive-store-'));
  const stores = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const open = async () => { const store = await CollaborationStore.open(directory); stores.push(store); return store; };
  return { directory, open };
}
const create = (id, value = { state: 'queued' }) => ({ table: 'tasks', id, expectedRevision: 0, value });

it('durably replays atomic multi-entity changes and sequence numbers', async (t) => {
  const { open } = await fixture(t);
  const store = await open();
  await store.transact(() => [create('a'), create('b')]);
  assert.equal(store.snapshot().seq, 1);
  await store.checkpoint();
  await store.close();
  const recovered = await open();
  assert.equal(recovered.get('tasks', 'a').revision, 1);
  assert.equal(recovered.get('tasks', 'b').state, 'queued');
  assert.equal(recovered.snapshot().seq, 1);
});

it('serializes builders against current state and rejects stale revisions', async (t) => {
  const { open } = await fixture(t);
  const store = await open();
  await store.transact(() => [create('a', { count: 0 })]);
  await Promise.all(Array.from({ length: 10 }, () => store.transact((state) => {
    const current = state.tables.tasks.a;
    return [{ table: 'tasks', id: 'a', expectedRevision: current.revision, value: { count: current.count + 1 } }];
  })));
  assert.equal(store.get('tasks', 'a').count, 10);
  await assert.rejects(store.transact(() => [{ table: 'tasks', id: 'a', expectedRevision: 1, value: {} }]), { code: 'REVISION_CONFLICT' });
  assert.equal(store.snapshot().seq, 11);
});

it('rejects a whole transaction if any operation is invalid, without poisoning valid writes', async (t) => {
  const { open } = await fixture(t);
  const store = await open();
  await assert.rejects(store.transact(() => [create('a'), create('a')]));
  assert.equal(store.get('tasks', 'a'), null);
  assert.equal(store.snapshot().seq, 0);
  await assert.rejects(store.transact(() => [create('a', { bad: undefined })]));
  await assert.rejects(store.transact(() => [create('__proto__')]));
  await assert.rejects(store.transact(() => [create('a', { revision: 99 })]));
  await store.transact(() => [create('a')]);
  assert.equal(store.get('tasks', 'a').revision, 1);
});

it('does not expose mutable internal state and supports no-op transactions', async (t) => {
  const { open } = await fixture(t);
  const store = await open();
  await store.transact(() => [create('a')]);
  store.get('tasks', 'a').state = 'completed';
  store.snapshot().tables.tasks.a.state = 'failed';
  store.list('tasks')[0].state = 'cancelled';
  await store.transact(() => []);
  assert.equal(store.get('tasks', 'a').state, 'queued');
  assert.equal(store.snapshot().seq, 1);
});

it('holds an exclusive writer lock and releases it on clean close', async (t) => {
  const { directory, open } = await fixture(t);
  const store = await open();
  await assert.rejects(CollaborationStore.open(directory), /writer lock exists/);
  await store.close();
  await open();
  await assert.rejects(store.transact(() => [create('a')]), /closed/);
});

it('fails closed on an incomplete journal tail without deleting evidence', async (t) => {
  const { directory, open } = await fixture(t);
  const store = await open();
  await store.transact(() => [create('a')]);
  await store.close();
  const journal = path.join(directory, 'events.jsonl');
  await appendFile(journal, '{"partial":', 'utf8');
  const evidence = await readFile(journal);
  await assert.rejects(open(), /incomplete tail/);
  assert.deepEqual(await readFile(journal), evidence);
});

it('detects checksum corruption rather than skipping a transaction', async (t) => {
  const { directory, open } = await fixture(t);
  const store = await open();
  await store.transact(() => [create('a')]);
  await store.close();
  const journal = path.join(directory, 'events.jsonl');
  const original = await readFile(journal, 'utf8');
  await writeFile(journal, original.replace('queued', 'failed'), 'utf8');
  await assert.rejects(open(), /checksum mismatch/);
});

it('writes a readable checkpoint but does not trust it instead of the journal', async (t) => {
  const { directory, open } = await fixture(t);
  const store = await open();
  await store.transact(() => [create('a')]);
  await store.checkpoint();
  const file = path.join(directory, 'snapshot.json');
  const checkpoint = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(checkpoint.state.seq, 1);
  await store.close();
  await writeFile(file, 'damaged checkpoint', 'utf8');
  const recovered = await open();
  assert.equal(recovered.get('tasks', 'a').state, 'queued');
});
