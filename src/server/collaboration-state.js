// Pure task transitions. Call only inside a CollaborationStore transaction,
// after the service authenticates the caller and checks the current revision.
// Returns a patch: the store, not this module, owns IDs and revisions.
import { CollaborationError, entityId, requiredText } from './collaboration-validation.js';

export const TASK_STATES = Object.freeze([
  'queued', 'running', 'awaiting_review', 'completed', 'failed', 'cancelled', 'uncertain',
]);

function conflict(message) {
  throw new CollaborationError(message, 409, 'INVALID_TRANSITION');
}

function requireState(task, states) {
  if (!states.includes(task.state)) conflict(`Cannot transition task from ${task.state}`);
}

function matchingAttempt(task, event) {
  entityId(event.attemptId, 'attemptId');
  if (task.attemptId !== event.attemptId) conflict('Stale or unrelated attempt');
}

function operatorOnly(authority) {
  // authority comes from the authenticated service, never from request JSON.
  if (authority !== 'operator') {
    throw new CollaborationError('Operator action required', 403, 'FORBIDDEN');
  }
}

export function taskTransition(task, event, { authority = 'runtime', now = Date.now() } = {}) {
  if (!task || !TASK_STATES.includes(task.state)) conflict('Unknown task state');
  if (!Number.isSafeInteger(now) || now < 0) throw new CollaborationError('Invalid transition timestamp');
  const patch = { updatedAt: now };
  switch (event?.type) {
    case 'start':
      requireState(task, ['queued']);
      if (task.cancelRequested) conflict('Cancellation is pending');
      entityId(event.attemptId, 'attemptId');
      if (event.attemptId === task.attemptId) conflict('A retry requires a new attempt ID');
      return { ...patch, state: 'running', attemptId: event.attemptId,
        startedAt: now, result: null, verification: null, error: null, cancelRequested: false };

    case 'result': {
      requireState(task, ['running']);
      matchingAttempt(task, event);
      if (task.cancelRequested) conflict('Late result after cancellation request');
      if (!['done', 'blocked', 'failed'].includes(event.result?.outcome)) {
        throw new CollaborationError('Invalid result outcome');
      }
      requiredText(event.result.summary, 'result.summary');
      // The adapter/service validates the full result schema before this call.
      // A model saying done is not verification and never completes a task.
      return { ...patch,
        state: event.result.outcome === 'done' ? 'awaiting_review' : 'failed',
        result: structuredClone(event.result), finishedAt: now,
        error: event.result.outcome === 'done' ? null : event.result.outcome };
    }

    case 'review': {
      // Operator review is the normal gate. The service itself may review only
      // origin:'message' turns (peer-message responses carry no write scope);
      // everything else needs a human.
      const serviceAutoReview = authority === 'service' && task.origin === 'message';
      if (authority !== 'operator' && !serviceAutoReview) {
        throw new CollaborationError('Operator action required', 403, 'FORBIDDEN');
      }
      requireState(task, ['awaiting_review']);
      matchingAttempt(task, event);
      if (typeof event.approved !== 'boolean') throw new CollaborationError('approved must be boolean');
      const evidence = requiredText(event.evidence, 'review evidence', 16000);
      return { ...patch, state: event.approved ? 'completed' : 'failed',
        verification: { approved: event.approved, evidence, source: authority, at: now },
        error: event.approved ? null : 'review-rejected' };
    }

    case 'cancel_requested':
      operatorOnly(authority);
      requireState(task, ['queued', 'running', 'awaiting_review', 'uncertain']);
      if (task.cancelRequested) conflict('Cancellation already requested');
      // Persist this before signalling the process. Running/uncertain attempts
      // remain nonterminal until the runtime confirms their process has stopped.
      return { ...patch, cancelRequested: true,
        state: ['queued', 'awaiting_review'].includes(task.state) ? 'cancelled' : task.state };

    case 'cancel_confirmed':
      requireState(task, ['running', 'uncertain']);
      matchingAttempt(task, event);
      if (!task.cancelRequested || event.processStopped !== true) {
        conflict('Cancellation requires a persisted request and confirmed process exit');
      }
      return { ...patch, state: 'cancelled', finishedAt: now };

    case 'interrupted':
      requireState(task, ['running']);
      matchingAttempt(task, event);
      return { ...patch, state: 'uncertain', error: requiredText(event.reason, 'interruption reason', 4000) };

    case 'retry':
      operatorOnly(authority);
      requireState(task, ['failed', 'cancelled', 'uncertain']);
      if (event.previousProcessStopped !== true || event.sideEffectsReviewed !== true) {
        conflict('Retry requires process-stop confirmation and side-effect review');
      }
      return { ...patch, state: 'queued', cancelRequested: false, error: null,
        retryReason: requiredText(event.reason, 'retry reason', 4000) };

    default:
      throw new CollaborationError('Unknown task transition');
  }
}

export function dependenciesComplete(task, tasksById) {
  if (!Array.isArray(task.dependencies)) return false;
  return task.dependencies.every((id) => Object.hasOwn(tasksById, id)
    && tasksById[id].runId === task.runId && tasksById[id].state === 'completed');
}
