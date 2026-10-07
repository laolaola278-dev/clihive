import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  CollaborationError, DEFAULT_RUN_LIMITS, directoryLockKey, effectivePermission,
  entityId, objectFields, requireRevision, validateAgentInput, validateRunInput,
  validateRunLimits,
} from '../src/server/collaboration-validation.js';

const runInput = () => ({
  objective: 'Review and verify a small change',
  agentIds: ['agent-a', 'agent-b'],
  acceptanceCriteria: ['Tests pass', 'Independent review is recorded'],
});

describe('managed collaboration validation', () => {
  it('defaults agent and run permissions to read-only', () => {
    const agent = validateAgentInput({ provider: 'codex', cwd: path.resolve('.') });
    assert.equal(agent.permissionProfile, 'read-only');
    assert.equal(validateRunInput(runInput()).permissionProfile, 'read-only');
  });

  it('does not accept executable overrides, sender claims, or elevated modes', () => {
    assert.throws(() => validateAgentInput({ provider: 'codex', cwd: path.resolve('.'), command: 'other' }), CollaborationError);
    assert.throws(() => validateRunInput({ ...runInput(), from: 'human' }), CollaborationError);
    assert.throws(() => validateRunInput({ ...runInput(), permissionProfile: 'danger-full-access' }), CollaborationError);
  });

  it('rejects unsupported providers and relative working directories', () => {
    assert.throws(() => validateAgentInput({ provider: 'gemini', cwd: path.resolve('.') }), CollaborationError);
    assert.throws(() => validateAgentInput({ provider: 'claude', cwd: './relative' }), CollaborationError);
  });

  it('requires named participants and explicit acceptance criteria', () => {
    assert.throws(() => validateRunInput({ ...runInput(), agentIds: [] }), CollaborationError);
    assert.throws(() => validateRunInput({ ...runInput(), agentIds: ['a', 'a'] }), CollaborationError);
    assert.throws(() => validateRunInput({ ...runInput(), acceptanceCriteria: [] }), CollaborationError);
    assert.throws(() => validateRunInput({ ...runInput(), acceptanceCriteria: [' '] }), CollaborationError);
  });

  it('uses bounded independent limit objects', () => {
    const limits = validateRunLimits();
    assert.deepEqual(limits, DEFAULT_RUN_LIMITS);
    limits.concurrency = 1;
    assert.equal(validateRunLimits().concurrency, 2);
    for (const value of [0, -1, 1.5, '2', Infinity, NaN, 9]) {
      assert.throws(() => validateRunLimits({ concurrency: value }), CollaborationError);
    }
    assert.throws(() => validateRunLimits({ unknown: 1 }), CollaborationError);
    assert.throws(() => validateRunLimits({ runTimeoutMs: 1000 }), CollaborationError);
  });

  it('requires explicit write permission on both agent and run', () => {
    assert.equal(effectivePermission('workspace-write', 'workspace-write'), 'workspace-write');
    assert.equal(effectivePermission('workspace-write', 'read-only'), 'read-only');
    assert.equal(effectivePermission('read-only', 'workspace-write'), 'read-only');
    assert.equal(effectivePermission(), 'read-only');
    assert.throws(() => effectivePermission('bypass', 'workspace-write'), CollaborationError);
  });

  it('canonicalizes Windows write lock casing and separators, preserving roots', () => {
    assert.equal(directoryLockKey('C:\\Work\\Repo\\', 'win32'), directoryLockKey('c:/work/repo', 'win32'));
    assert.equal(directoryLockKey('C:\\', 'win32'), 'c:\\');
    assert.equal(directoryLockKey('/work/Repo/', 'linux'), '/work/Repo');
    assert.notEqual(directoryLockKey('/work/Repo', 'linux'), directoryLockKey('/work/repo', 'linux'));
  });

  it('rejects malformed objects, IDs, and NUL input', () => {
    for (const value of [null, [], 'text', new Date()]) {
      assert.throws(() => objectFields(value, []), CollaborationError);
    }
    for (const value of ['', '../other', 'has space', 'x\0y']) {
      assert.throws(() => entityId(value), CollaborationError);
    }
    assert.throws(() => validateRunInput({ ...runInput(), objective: 'task\0hidden' }), CollaborationError);
    assert.throws(() => objectFields(JSON.parse('{"__proto__":{}}'), []), CollaborationError);
  });

  it('enforces compare-and-set revisions with an explicit conflict', () => {
    requireRevision(2, 2);
    assert.throws(() => requireRevision(2, 1), (err) => err.statusCode === 409 && err.code === 'REVISION_CONFLICT');
    assert.throws(() => requireRevision(2, '2'), CollaborationError);
  });
});
