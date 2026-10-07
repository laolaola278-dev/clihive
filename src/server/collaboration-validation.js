// Validation at the managed-collaboration boundary. Never infer permission
// from an executable name, model output, or a client's claimed sender identity.
import path from 'node:path';

export class CollaborationError extends Error {
  constructor(message, statusCode = 400, code = 'INVALID_INPUT') {
    super(message);
    this.name = 'CollaborationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function objectFields(value, allowed, label = 'input') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new CollaborationError(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new CollaborationError(`${label}: unknown field ${key}`);
  }
  return value;
}

export function requiredText(value, label, max = 64000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new CollaborationError(`${label} must be nonempty text of at most ${max} characters without NUL`);
  }
  return value.trim();
}

export function entityId(value, label = 'id') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(value)) {
    throw new CollaborationError(`${label} is invalid`);
  }
  return value;
}

export function positiveInteger(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new CollaborationError(`${label} must be an integer between 1 and ${max}`);
  }
  return value;
}

export function requireRevision(actual, expected) {
  positiveInteger(expected, 'revision');
  if (actual !== expected) {
    throw new CollaborationError('State changed; read the current revision before retrying', 409, 'REVISION_CONFLICT');
  }
}

export function uniqueIds(value, label, { min = 0, max = 32 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new CollaborationError(`${label} must contain ${min} to ${max} IDs`);
  }
  const result = value.map((id) => entityId(id, label));
  if (new Set(result).size !== result.length) throw new CollaborationError(`${label} contains duplicate IDs`);
  return result;
}

export function permissionProfile(value = 'read-only') {
  if (!['read-only', 'workspace-write'].includes(value)) {
    throw new CollaborationError('permissionProfile must be read-only or workspace-write');
  }
  return value;
}

// Windows aliases and casing must not create separate write locks. At agent
// registration the manager must first resolve the real directory (realpath),
// verify it exists, and then call this function. This is not a sandbox.
export function directoryLockKey(realDirectory, platform = process.platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  requiredText(realDirectory, 'cwd', 32768);
  if (!api.isAbsolute(realDirectory)) throw new CollaborationError('cwd must be absolute');
  const normalized = api.normalize(realDirectory);
  const root = api.parse(normalized).root;
  const trimmed = normalized.length > root.length ? normalized.replace(/[\\/]+$/, '') : normalized;
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

export function validateAgentInput(input) {
  objectFields(input, ['provider', 'label', 'cwd', 'permissionProfile'], 'agent');
  if (!['codex', 'claude'].includes(input.provider)) {
    throw new CollaborationError('Managed agents support only codex and claude');
  }
  const cwd = requiredText(input.cwd, 'cwd', 32768);
  directoryLockKey(cwd);
  return {
    provider: input.provider,
    label: input.label === undefined ? input.provider : requiredText(input.label, 'label', 120),
    cwd,
    permissionProfile: permissionProfile(input.permissionProfile),
  };
}

export const DEFAULT_RUN_LIMITS = Object.freeze({
  concurrency: 2,
  decisions: 20,
  agentTurns: 50,
  taskTimeoutMs: 600000,
  runTimeoutMs: 3600000,
  handoffDepth: 8,
  messagesPerTurn: 8,
});

const MAX_RUN_LIMITS = Object.freeze({
  concurrency: 8,
  decisions: 200,
  agentTurns: 500,
  taskTimeoutMs: 3600000,
  runTimeoutMs: 86400000,
  handoffDepth: 32,
  messagesPerTurn: 32,
});

export function validateRunLimits(input = {}) {
  objectFields(input, Object.keys(DEFAULT_RUN_LIMITS), 'limits');
  const result = { ...DEFAULT_RUN_LIMITS };
  for (const [key, value] of Object.entries(input)) {
    result[key] = positiveInteger(value, `limits.${key}`, MAX_RUN_LIMITS[key]);
  }
  if (result.taskTimeoutMs > result.runTimeoutMs) {
    throw new CollaborationError('taskTimeoutMs cannot exceed runTimeoutMs');
  }
  return result;
}

export function validateRunInput(input) {
  objectFields(input, ['objective', 'agentIds', 'acceptanceCriteria', 'limits', 'permissionProfile'], 'run');
  if (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.length < 1
      || input.acceptanceCriteria.length > 32) {
    throw new CollaborationError('acceptanceCriteria must contain 1 to 32 explicit criteria');
  }
  return {
    objective: requiredText(input.objective, 'objective'),
    agentIds: uniqueIds(input.agentIds, 'agentIds', { min: 1 }),
    acceptanceCriteria: input.acceptanceCriteria.map((v) => requiredText(v, 'acceptance criterion', 4000)),
    limits: validateRunLimits(input.limits),
    permissionProfile: permissionProfile(input.permissionProfile),
  };
}

export function validateTaskInput(input, { assigneeIds }) {
  objectFields(input, ['id', 'assignee', 'instruction', 'dependencies', 'writeScopes', 'origin', 'depth'], 'task');
  const assignee = entityId(input.assignee, 'task.assignee');
  if (!assigneeIds.includes(assignee)) {
    throw new CollaborationError('task.assignee is not a member of this run');
  }
  const dependencies = uniqueIds(input.dependencies ?? [], 'task.dependencies');
  const writeScopes = Array.isArray(input.writeScopes)
    ? input.writeScopes.map((scope) => requiredText(scope, 'writeScope', 4096)).slice(0, 32)
    : [];
  if (input.writeScopes !== undefined && !Array.isArray(input.writeScopes)) {
    throw new CollaborationError('task.writeScopes must be an array');
  }
  return {
    id: entityId(input.id, 'task.id'),
    assignee,
    instruction: requiredText(input.instruction, 'task.instruction'),
    dependencies,
    writeScopes,
    origin: ['operator', 'planner', 'followup', 'message'].includes(input.origin) ? input.origin : 'operator',
    depth: input.depth === undefined ? 0 : positiveInteger(input.depth, 'task.depth', 64),
  };
}

// Permissions are intersected, never combined. Only the operator boundary may
// authorize either profile; model-generated tasks cannot elevate this result.
export function effectivePermission(agentProfile, runProfile) {
  const agent = permissionProfile(agentProfile);
  const run = permissionProfile(runProfile);
  return agent === 'workspace-write' && run === 'workspace-write' ? 'workspace-write' : 'read-only';
}
