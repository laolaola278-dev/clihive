import { it } from 'node:test';
import assert from 'node:assert/strict';
import { taskTransition, dependenciesComplete } from '../src/server/collaboration-state.js';

const base = () => ({ id: 'task-a', runId: 'run-a', state: 'queued', dependencies: [], attemptId: null });
const apply = (task, event, options) => ({ ...task, ...taskTransition(task, event, options) });
const started = () => apply(base(), { type: 'start', attemptId: 'attempt-a' });
const resultEvent = () => ({ type: 'result', attemptId: 'attempt-a', result: { outcome: 'done', summary: 'Tests executed' } });
const operator = { authority: 'operator', now: 100 };

it('requires review evidence after a successful execution result', () => {
  const pending = apply(started(), resultEvent());
  assert.equal(pending.state, 'awaiting_review');
  assert.equal(pending.verification, null);
  const reviewed = apply(pending, { type: 'review', attemptId: 'attempt-a', approved: true, evidence: 'Independent checks passed' }, operator);
  assert.equal(reviewed.state, 'completed');
  assert.equal(reviewed.verification.source, 'operator');
  assert.equal(reviewed.verification.at, 100);
});

it('does not let runtime/model results authorize review or retries', () => {
  const pending = apply(started(), resultEvent());
  assert.throws(() => taskTransition(pending, { type: 'review', attemptId: 'attempt-a', approved: true, evidence: 'done' }), { code: 'FORBIDDEN' });
  assert.throws(() => taskTransition({ ...base(), state: 'failed' }, { type: 'retry' }), { code: 'FORBIDDEN' });
  assert.throws(() => taskTransition(pending, { type: 'review', attemptId: 'attempt-a', approved: true, evidence: '' }, operator));
});

it('rejects duplicate, unrelated, and stale result events', () => {
  assert.throws(() => taskTransition(started(), { ...resultEvent(), attemptId: 'other' }), { code: 'INVALID_TRANSITION' });
  const pending = apply(started(), resultEvent());
  assert.throws(() => taskTransition(pending, resultEvent()), { code: 'INVALID_TRANSITION' });
  assert.throws(() => taskTransition(base(), resultEvent()), { code: 'INVALID_TRANSITION' });
});

it('records blocked or failed outcomes without claiming task completion', () => {
  for (const outcome of ['blocked', 'failed']) {
    const next = apply(started(), { ...resultEvent(), result: { outcome, summary: 'Permission required' } });
    assert.equal(next.state, 'failed');
    assert.equal(next.error, outcome);
  }
  assert.throws(() => taskTransition(started(), { ...resultEvent(), result: { outcome: 'success', summary: 'x' } }));
});

it('persists cancellation intent before requiring confirmed process exit', () => {
  const cancelling = apply(started(), { type: 'cancel_requested' }, operator);
  assert.equal(cancelling.state, 'running');
  assert.equal(cancelling.cancelRequested, true);
  assert.throws(() => taskTransition(cancelling, resultEvent()), { code: 'INVALID_TRANSITION' });
  assert.throws(() => taskTransition(cancelling, { type: 'cancel_confirmed', attemptId: 'attempt-a', processStopped: false }));
  const cancelled = apply(cancelling, { type: 'cancel_confirmed', attemptId: 'attempt-a', processStopped: true });
  assert.equal(cancelled.state, 'cancelled');
  assert.throws(() => taskTransition(cancelled, resultEvent()));
  assert.equal(apply(base(), { type: 'cancel_requested' }, operator).state, 'cancelled');
});

it('makes interrupted attempts uncertain and requires explicit safe retry', () => {
  const uncertain = apply(started(), { type: 'interrupted', attemptId: 'attempt-a', reason: 'Server restarted' });
  assert.equal(uncertain.state, 'uncertain');
  assert.throws(() => taskTransition(uncertain, { type: 'start', attemptId: 'attempt-b' }));
  assert.throws(() => taskTransition(uncertain, { type: 'retry', reason: 'retry' }, operator));
  const queued = apply(uncertain, { type: 'retry', reason: 'Checked process and working tree', previousProcessStopped: true, sideEffectsReviewed: true }, operator);
  assert.throws(() => taskTransition(queued, { type: 'start', attemptId: 'attempt-a' }));
  assert.equal(apply(queued, { type: 'start', attemptId: 'attempt-b' }).state, 'running');
});

it('requires dependencies from the same run to be verified complete', () => {
  const task = { ...base(), dependencies: ['parent'] };
  assert.equal(dependenciesComplete(task, {}), false);
  assert.equal(dependenciesComplete(task, { parent: { runId: 'run-a', state: 'awaiting_review' } }), false);
  assert.equal(dependenciesComplete(task, { parent: { runId: 'other', state: 'completed' } }), false);
  assert.equal(dependenciesComplete(task, { parent: { runId: 'run-a', state: 'completed' } }), true);
  assert.equal(dependenciesComplete(base(), {}), true);
});

it('does not mutate task or result inputs', () => {
  const task = started();
  const before = structuredClone(task);
  const event = resultEvent();
  const patch = taskTransition(task, event);
  patch.result.summary = 'changed';
  assert.deepEqual(task, before);
  assert.equal(event.result.summary, 'Tests executed');
});
