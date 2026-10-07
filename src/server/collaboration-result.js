// Validate model-produced results before persisting them or dispatching messages.
// This validates shape, not truth: done still requires independent review.
import {
  CollaborationError, entityId, objectFields, requiredText, uniqueIds,
} from './collaboration-validation.js';

function boundedArray(value, label, max) {
  if (!Array.isArray(value) || value.length > max) {
    throw new CollaborationError(`${label} must be an array of at most ${max} items`);
  }
  return value;
}

export function validateAgentResult(input, { recipientIds, messagesPerTurn = 8 } = {}) {
  objectFields(input, ['summary', 'outcome', 'artifacts', 'checks', 'messages', 'followUps', 'question'], 'result');
  if (!['done', 'blocked', 'failed'].includes(input.outcome)) {
    throw new CollaborationError('result.outcome must be done, blocked, or failed');
  }
  if (!Number.isSafeInteger(messagesPerTurn) || messagesPerTurn < 1 || messagesPerTurn > 32) {
    throw new CollaborationError('Invalid result message limit');
  }
  // Supply the current Run membership at the service boundary. An empty list
  // deliberately permits no outbound recipients; omitted membership is invalid.
  const recipients = new Set(uniqueIds(recipientIds, 'recipientIds'));
  const summary = requiredText(input.summary, 'result.summary', 16000);
  const artifacts = boundedArray(input.artifacts, 'result.artifacts', 32).map((item) => {
    objectFields(item, ['path', 'description'], 'artifact');
    return {
      path: requiredText(item.path, 'artifact.path', 4096),
      description: requiredText(item.description, 'artifact.description', 4000),
    };
  });
  // Artifact paths are claims, not permission to read or execute those paths.
  // A later verifier must resolve and constrain them to the approved workspace.
  const checks = boundedArray(input.checks, 'result.checks', 32).map((item) => {
    objectFields(item, ['name', 'status', 'evidence'], 'check');
    if (!['passed', 'failed', 'not_run'].includes(item.status)) {
      throw new CollaborationError('check.status must be passed, failed, or not_run');
    }
    return {
      name: requiredText(item.name, 'check.name', 240),
      status: item.status,
      evidence: requiredText(item.evidence, 'check.evidence', 8000),
    };
  });
  const messages = boundedArray(input.messages, 'result.messages', messagesPerTurn).map((item) => {
    objectFields(item, ['to', 'text'], 'message');
    const to = entityId(item.to, 'message.to');
    if (!recipients.has(to)) throw new CollaborationError('Message recipient is not an allowed Run participant');
    return { to, text: requiredText(item.text, 'message.text', 16000) };
  });
  const followUps = boundedArray(input.followUps, 'result.followUps', 8).map((item) => {
    objectFields(item, ['assignee', 'instruction', 'dependencies'], 'followUp');
    const assignee = entityId(item.assignee, 'followUp.assignee');
    if (!recipients.has(assignee)) throw new CollaborationError('Follow-up assignee is not an allowed Run participant');
    return {
      assignee,
      instruction: requiredText(item.instruction, 'followUp.instruction', 16000),
      dependencies: uniqueIds(item.dependencies, 'followUp.dependencies'),
    };
  });
  // Follow-ups remain proposals. The scheduler must independently check task
  // ownership, dependencies, cycles, permission intersection, and Run budget.
  const question = input.question === null ? null : requiredText(input.question, 'result.question', 4000);
  if (input.outcome === 'blocked' && question === null) {
    throw new CollaborationError('A blocked result requires a concrete question for the operator');
  }
  const result = { summary, outcome: input.outcome, artifacts, checks, messages, followUps, question };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 256 * 1024) {
    throw new CollaborationError('Agent result exceeds 256 KiB');
  }
  return result;
}
