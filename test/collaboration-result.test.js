import { it } from 'node:test';
import assert from 'node:assert/strict';
import { validateAgentResult } from '../src/server/collaboration-result.js';

const valid = () => ({
  summary: 'Change ready for independent review', outcome: 'done',
  artifacts: [{ path: 'src/example.js', description: 'Implementation candidate' }],
  checks: [{ name: 'unit', status: 'passed', evidence: 'Reported 2 passing tests' }],
  messages: [{ to: 'agent-b', text: 'Please review the candidate' }],
  followUps: [{ assignee: 'agent-b', instruction: 'Review independently', dependencies: ['task-a'] }],
  question: null,
});
const context = { recipientIds: ['agent-a', 'agent-b'] };

it('normalizes a structured result without treating model claims as verification', () => {
  const result = validateAgentResult(valid(), context);
  assert.equal(result.outcome, 'done');
  assert.equal(result.messages[0].to, 'agent-b');
  assert.equal(Object.hasOwn(result, 'verification'), false);
  assert.equal(Object.hasOwn(result, 'state'), false);
});

it('rejects sender impersonation, permissions, executable fields, and model-assigned state', () => {
  for (const field of ['from', 'permissionProfile', 'command', 'state', 'verification']) {
    assert.throws(() => validateAgentResult({ ...valid(), [field]: 'injected' }, context));
  }
  const input = valid();
  input.messages[0].from = 'human';
  assert.throws(() => validateAgentResult(input, context));
  const followUp = valid();
  followUp.followUps[0].permissionProfile = 'workspace-write';
  assert.throws(() => validateAgentResult(followUp, context));
});

it('requires explicit current membership and rejects unknown recipients or broadcast shortcuts', () => {
  assert.throws(() => validateAgentResult(valid()));
  assert.throws(() => validateAgentResult(valid(), { recipientIds: [] }));
  for (const to of ['outside-agent', 'all', 'human', 'orchestrator']) {
    const input = valid();
    input.messages[0].to = to;
    assert.throws(() => validateAgentResult(input, context));
  }
  const input = valid();
  input.followUps[0].assignee = 'outside-agent';
  assert.throws(() => validateAgentResult(input, context));
});

it('enforces message count, explicit arrays, and a concrete blocked question', () => {
  const input = valid();
  input.messages.push({ to: 'agent-a', text: 'another message' });
  assert.throws(() => validateAgentResult(input, { ...context, messagesPerTurn: 1 }));
  for (const field of ['artifacts', 'checks', 'messages', 'followUps']) {
    assert.throws(() => validateAgentResult({ ...valid(), [field]: undefined }, context));
  }
  assert.throws(() => validateAgentResult({ ...valid(), outcome: 'blocked' }, context));
  const result = validateAgentResult({ ...valid(), outcome: 'blocked', question: 'May I modify the approved workspace?' }, context);
  assert.equal(result.outcome, 'blocked');
});

it('rejects malformed checks, missing evidence, invalid dependencies, and NUL strings', () => {
  for (const status of ['success', true, null]) {
    const input = valid();
    input.checks[0].status = status;
    assert.throws(() => validateAgentResult(input, context));
  }
  const input = valid();
  input.checks[0].evidence = '';
  assert.throws(() => validateAgentResult(input, context));
  const duplicate = valid();
  duplicate.followUps[0].dependencies = ['task-a', 'task-a'];
  assert.throws(() => validateAgentResult(duplicate, context));
  assert.throws(() => validateAgentResult({ ...valid(), summary: 'hidden\0text' }, context));
});

it('caps total UTF-8 result bytes independently of individual field lengths', () => {
  const input = valid();
  input.checks = Array.from({ length: 32 }, () => ({ name: 'check', status: 'passed', evidence: '汉'.repeat(7000) }));
  assert.throws(() => validateAgentResult(input, context), /256 KiB/);
});

it('returns independent objects and retains failed-check claims for later review', () => {
  const input = valid();
  input.checks[0].status = 'failed';
  const result = validateAgentResult(input, context);
  result.messages[0].text = 'changed';
  result.followUps[0].dependencies.push('task-b');
  assert.equal(input.messages[0].text, 'Please review the candidate');
  assert.deepEqual(input.followUps[0].dependencies, ['task-a']);
  assert.equal(result.checks[0].status, 'failed');
  // Contradictory model claims must reach the review gate, not be auto-approved.
  assert.equal(Object.hasOwn(result, 'verification'), false);
});
