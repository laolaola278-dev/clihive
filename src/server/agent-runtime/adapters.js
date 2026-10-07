// Codex and Claude managed-agent adapters.
//
// One interface, two CLIs, no terminal emulation:
//   buildArgs      — pure argv construction (asserted in tests; never a shell)
//   normalizeEvent — provider JSONL -> the unified event vocabulary
//   finalize       — exit state + authoritative structured result
// Hard rules: no bypass/danger flags ever; permission prompts are answered by
// denying (claude --permission-prompts none; codex sandbox policy), which turns
// "needs approval" into a reportable blocked outcome instead of a silent yes.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { JsonlParser } from './jsonl.js';

export const UNIFIED_EVENTS = Object.freeze([
  'session', 'text', 'tool', 'result', 'permission_denied', 'error', 'exit', 'diagnostic',
]);

const STDERR_TAIL_BYTES = 64 * 1024;
const DIAGNOSTIC_CHARS = 500;

export function killProcessTree(child, platform = process.platform) {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  try {
    if (platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // Best effort; the exit handler reports the real outcome.
  }
}

function diagnostic(raw) {
  let text;
  try {
    text = JSON.stringify(raw);
  } catch {
    text = String(raw);
  }
  return { type: 'diagnostic', text: text.slice(0, DIAGNOSTIC_CHARS) };
}

function boundedText(value, max = 16000) {
  if (typeof value !== 'string') return '';
  return value.length > max ? `${value.slice(0, max)}...<truncated>` : value;
}

// --- Codex ------------------------------------------------------------------

export const codexAdapter = {
  provider: 'codex',
  supportsSchemaFile: true,

  buildArgs({ cwd, permissionProfile, sessionId, schemaPath, lastMessagePath }) {
    const sandbox = permissionProfile === 'workspace-write' ? 'workspace-write' : 'read-only';
    const common = [
      '--json', '--color', 'never', '--skip-git-repo-check',
      '-C', cwd,
      '--sandbox', sandbox,
      '--output-schema', schemaPath,
      '-o', lastMessagePath,
    ];
    // Prompt always travels over stdin ("-"), never as an argv string.
    return sessionId
      ? ['exec', 'resume', ...common, sessionId, '-']
      : ['exec', ...common, '-'];
  },

  normalizeEvent(raw) {
    if (!raw || typeof raw !== 'object') return [];
    const msg = raw.msg && typeof raw.msg === 'object' ? raw.msg : raw;
    const type = msg.type ?? raw.type;
    const out = [];
    const threadId = msg.thread_id ?? raw.thread_id ?? msg.session_id ?? raw.session_id;
    if (typeof threadId === 'string' && threadId) out.push({ type: 'session', sessionId: threadId });

    switch (type) {
      case 'thread.started':
      case 'session.created':
        break; // session already captured above
      case 'agent_message':
        out.push({ type: 'text', text: boundedText(msg.message) });
        break;
      case 'item.started':
      case 'item.completed': {
        const item = msg.item ?? {};
        if (item.type === 'agent_message') {
          if (type === 'item.completed') out.push({ type: 'text', text: boundedText(item.text) });
        } else if (['command_execution', 'tool_call', 'mcp_tool_call', 'file_change'].includes(item.type)) {
          const tool = {
            type: 'tool',
            name: item.type,
            detail: boundedText(item.command ?? item.tool ?? item.path ?? item.name ?? '', 2000),
            phase: type === 'item.started' ? 'started' : 'completed',
            status: item.status ?? null,
          };
          out.push(tool);
          const combined = `${item.status ?? ''} ${item.aggregated_output ?? item.output ?? ''}`;
          if (/sandbox.*(denied|not permitted)|not approved|permission denied/i.test(combined)) {
            out.push({ type: 'permission_denied', detail: boundedText(combined, 2000) });
          }
        } else if (item.type === 'error_message') {
          out.push({ type: 'error', message: boundedText(item.text ?? '') });
        } else if (type === 'item.completed') {
          out.push(diagnostic(raw));
        }
        break;
      }
      case 'exec_command_begin':
        out.push({ type: 'tool', name: 'command', detail: boundedText(Array.isArray(msg.command) ? msg.command.join(' ') : '', 2000), phase: 'started', status: null });
        break;
      case 'exec_command_end':
        out.push({ type: 'tool', name: 'command', detail: boundedText(msg.stdout ?? '', 2000), phase: 'completed', status: msg.exit_code === 0 ? 'ok' : `exit ${msg.exit_code}` });
        break;
      case 'error':
      case 'stream_error':
      case 'turn.failed': {
        const message = boundedText(msg.message ?? msg.error ?? raw.error ?? '');
        out.push(/sandbox|approval|permission/i.test(message)
          ? { type: 'permission_denied', detail: message }
          : { type: 'error', message });
        break;
      }
      case 'turn.completed':
      case 'task_complete':
      case 'token_count':
        break; // bookkeeping; completion comes from process exit + result file
      default:
        out.push(diagnostic(raw));
    }
    return out;
  },

  async finalize({ exitCode, timedOut, spawnError, stderrTail, lastMessagePath }) {
    if (spawnError) return { error: `codex failed to start: ${spawnError}` };
    if (timedOut) return { error: 'codex turn timed out and the process tree was killed' };
    if (exitCode !== 0) {
      return { error: `codex exited with code ${exitCode}${stderrTail ? `: ${stderrTail.slice(-2000)}` : ''}` };
    }
    try {
      const text = await readFile(lastMessagePath, 'utf8');
      return { rawResult: JSON.parse(text), error: null };
    } catch (err) {
      return { error: err.code === 'ENOENT'
        ? 'codex exited 0 but wrote no final message file'
        : `codex final message is not valid JSON: ${err.message}` };
    }
  },
};

// --- Claude -----------------------------------------------------------------

export const claudeAdapter = {
  provider: 'claude',
  supportsSchemaFile: false, // schema travels inline via --json-schema

  buildArgs({ cwd, permissionProfile, sessionId, schemaJson }) {
    const args = [
      '-p', '--verbose',
      '--output-format', 'stream-json',
      '--input-format', 'text',
      '--json-schema', schemaJson,
      '--permission-prompts', 'none',
    ];
    if (permissionProfile === 'workspace-write') {
      // acceptEdits auto-approves file edits inside the working directories;
      // Bash/Edit are allowed explicitly; anything else is denied, not asked.
      args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'Bash Edit Write NotebookEdit Read Glob Grep LS TodoWrite Task');
    } else {
      // plan mode forbids edits and command execution; prompts are denied.
      args.push('--permission-mode', 'plan');
    }
    args.push('--add-dir', cwd);
    if (sessionId) args.push('--resume', sessionId);
    return args;
  },

  normalizeEvent(raw) {
    if (!raw || typeof raw !== 'object') return [];
    const out = [];
    if (typeof raw.session_id === 'string' && raw.session_id) {
      out.push({ type: 'session', sessionId: raw.session_id });
    }
    switch (raw.type) {
      case 'system':
        break; // init captured via session_id above
      case 'assistant': {
        const blocks = raw.message?.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block?.type === 'text') out.push({ type: 'text', text: boundedText(block.text) });
            else if (block?.type === 'tool_use') {
              out.push({ type: 'tool', name: block.name ?? 'tool', detail: boundedText(JSON.stringify(block.input ?? {}), 2000), phase: 'started', status: null, toolUseId: block.id ?? null });
            }
          }
        }
        break;
      }
      case 'user': {
        const blocks = raw.message?.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block?.type !== 'tool_result') continue;
            const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
            const event = { type: 'tool', name: 'tool_result', detail: boundedText(content, 2000), phase: 'completed', status: block.is_error ? 'error' : 'ok', toolUseId: block.tool_use_id ?? null };
            out.push(event);
            if (block.is_error && /permission|not allowed|denied|requires approval/i.test(content)) {
              out.push({ type: 'permission_denied', detail: boundedText(content, 2000) });
            }
          }
        }
        break;
      }
      case 'result':
        out.push({
          type: 'result',
          subtype: raw.subtype ?? null,
          isError: raw.is_error === true,
          resultText: typeof raw.result === 'string' ? raw.result : null,
          numTurns: raw.num_turns ?? null,
          costUsd: raw.total_cost_usd ?? null,
        });
        break;
      default:
        out.push(diagnostic(raw));
    }
    return out;
  },

  async finalize({ exitCode, timedOut, spawnError, stderrTail, lastResultEvent }) {
    if (spawnError) return { error: `claude failed to start: ${spawnError}` };
    if (timedOut) return { error: 'claude turn timed out and the process tree was killed' };
    if (!lastResultEvent) {
      return { error: `claude stream ended without a result event (exit ${exitCode})${stderrTail ? `: ${stderrTail.slice(-2000)}` : ''}` };
    }
    if (lastResultEvent.isError || lastResultEvent.subtype !== 'success') {
      return { error: `claude reported ${lastResultEvent.subtype ?? 'an error'}${stderrTail ? `: ${stderrTail.slice(-2000)}` : ''}` };
    }
    if (exitCode !== 0) return { error: `claude exited with code ${exitCode} despite a success result` };
    if (lastResultEvent.resultText === null) return { error: 'claude result event carried no result text' };
    try {
      return { rawResult: JSON.parse(lastResultEvent.resultText), error: null };
    } catch (err) {
      return { error: `claude structured result is not valid JSON: ${err.message}` };
    }
  },
};

// --- opencode ---------------------------------------------------------------
//
// Verified against opencode 1.18.34 (`opencode run --format json`). It has no
// structured-output flag, so the result contract rides in the prompt and the
// last text part must be one JSON object; the server re-validates it anyway.
// Permissions are enforced by the CLI itself through OPENCODE_CONFIG_CONTENT:
//   read-only       -> `plan` agent + edit/bash/webfetch denied
//   workspace-write -> `build` agent + edit/bash allowed, webfetch denied
// and external_directory is always denied, so file tools cannot leave the
// working directory (observed: an out-of-directory write fails). Bash is NOT
// path-confined by opencode in workspace-write — same trust as claude's Bash.
// There is no auto-approve flag (`--auto` is never passed).

const OPENCODE_DENIED_RE = /rule which prevents|permission|not allowed|denied|requires approval/i;

export function stripJsonFence(text) {
  const trimmed = String(text ?? '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * opencode has no structured-output switch, so models wrap the JSON object
 * inconsistently (bare, fenced, prose before/after, stray "json" label).
 * Try progressively looser extractions; the first that parses to an OBJECT
 * wins. The server re-validates the shape afterwards, so being tolerant about
 * packaging does not loosen the contract.
 */
export function extractJsonObject(text) {
  const raw = String(text ?? '').trim();
  const candidates = [raw, stripJsonFence(raw)];
  for (const m of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(m[1].trim());
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return { value, error: null };
      lastError = new Error('JSON value is not an object');
    } catch (err) {
      lastError = err;
    }
  }
  return { value: null, error: lastError ?? new Error('empty message') };
}

export const opencodeAdapter = {
  provider: 'opencode',
  supportsSchemaFile: false, // contract travels in the prompt; no schema flag exists

  buildArgs({ cwd, permissionProfile, sessionId, model }) {
    const args = [
      'run', '--pure', '--format', 'json',
      '--agent', permissionProfile === 'workspace-write' ? 'build' : 'plan',
      '--dir', cwd,
    ];
    if (model) args.push('-m', model);
    if (sessionId) args.push('-s', sessionId);
    return args; // prompt is read from stdin
  },

  buildEnv({ permissionProfile }) {
    const write = permissionProfile === 'workspace-write' ? 'allow' : 'deny';
    return {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { edit: write, bash: write, webfetch: 'deny', external_directory: 'deny' },
      }),
    };
  },

  normalizeEvent(raw) {
    if (!raw || typeof raw !== 'object') return [];
    const out = [];
    if (typeof raw.sessionID === 'string' && raw.sessionID) {
      out.push({ type: 'session', sessionId: raw.sessionID });
    }
    const part = raw.part ?? {};
    switch (raw.type) {
      case 'step_start':
      case 'step_finish':
        break;
      case 'text':
        if (typeof part.text === 'string' && part.text.trim()) {
          // Every text part is a candidate final answer; the adapter keeps the last.
          out.push({ type: 'text', text: boundedText(part.text) });
          out.push({ type: 'result', resultText: part.text, isError: false, subtype: 'text' });
        }
        break;
      case 'tool_use': {
        const state = part.state ?? {};
        out.push({
          type: 'tool', name: part.tool ?? 'tool',
          detail: boundedText(JSON.stringify(state.input ?? {}), 2000),
          phase: state.status === 'completed' || state.status === 'error' ? 'completed' : 'started',
          status: state.status === 'error' ? 'error' : state.status === 'completed' ? 'ok' : null,
          toolUseId: part.callID ?? null,
        });
        if (state.status === 'error' && OPENCODE_DENIED_RE.test(String(state.error ?? ''))) {
          out.push({ type: 'permission_denied', detail: boundedText(String(state.error), 2000) });
        }
        break;
      }
      case 'error': {
        const data = raw.error?.data ?? {};
        out.push({
          type: 'error', code: raw.error?.name ?? null,
          message: boundedText(data.message ?? JSON.stringify(raw.error ?? {}), 2000),
        });
        break;
      }
      default:
        out.push(diagnostic(raw));
    }
    return out;
  },

  async finalize({ exitCode, timedOut, spawnError, stderrTail, lastResultEvent, errorMessage }) {
    if (spawnError) return { error: `opencode failed to start: ${spawnError}` };
    if (timedOut) return { error: 'opencode turn timed out and the process tree was killed' };
    if (errorMessage) return { error: `opencode reported an error: ${errorMessage}` };
    if (exitCode !== 0) return { error: `opencode exited with code ${exitCode}${stderrTail ? `: ${stderrTail.slice(-2000)}` : ''}` };
    if (!lastResultEvent) return { error: 'opencode stream ended without a final text message' };
    const parsed = extractJsonObject(lastResultEvent.resultText);
    if (parsed.error) {
      const head = String(lastResultEvent.resultText ?? '').slice(0, 160).replace(/\s+/g, ' ');
      return { error: `opencode final message is not a valid JSON object: ${parsed.error.message} (starts: ${JSON.stringify(head)})` };
    }
    return { rawResult: parsed.value, error: null };
  },
};

export const ADAPTERS = Object.freeze({
  codex: codexAdapter, claude: claudeAdapter, opencode: opencodeAdapter,
});

/** Local, side-effect-free capability probe: `<cli> --version`. */
export async function detectCli(executable, { timeoutMs = 15000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      child = spawnImpl(executable.command, [...executable.prependArgs, '--version'], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (err) {
      finish({ available: false, reason: err.message });
      return;
    }
    let stdout = '';
    const timer = setTimeout(() => { killProcessTree(child); finish({ available: false, reason: 'version probe timed out' }); }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk; if (stdout.length > 8192) killProcessTree(child); });
    child.on('error', (err) => { clearTimeout(timer); finish({ available: false, reason: err.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const version = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? null;
      finish(code === 0 && version
        ? { available: true, version }
        : { available: false, reason: `--version exited with code ${code}` });
    });
  });
}

/**
 * Run one managed turn. The prompt goes in over stdin; events stream out via
 * onEvent; the promise resolves with the authoritative outcome. Never throws
 * for agent-side failures: those come back as { error }.
 */
export async function runTurn(adapter, options) {
  const {
    executable, prompt, cwd, permissionProfile = 'read-only', sessionId = null, model = null,
    schema, timeoutMs, env = process.env, spawnImpl = spawn, onEvent = () => {},
    onSpawn = null, platform = process.platform,
  } = options;

  const workDir = await mkdtemp(path.join(tmpdir(), `clihive-${adapter.provider}-`));
  const schemaPath = path.join(workDir, 'result-schema.json');
  const lastMessagePath = path.join(workDir, 'last-message.json');
  const schemaJson = JSON.stringify(schema);
  if (adapter.supportsSchemaFile) await writeFile(schemaPath, schemaJson, 'utf8');

  const args = adapter.buildArgs({ cwd, permissionProfile, sessionId, schemaPath, lastMessagePath, schemaJson, model });
  // Adapters may enforce permissions through the environment (opencode).
  const childEnv = adapter.buildEnv ? { ...env, ...adapter.buildEnv({ permissionProfile }) } : env;
  const parser = new JsonlParser();
  let stderrTail = '';
  let timedOut = false;
  let spawnError = null;
  let errorMessage = null;
  let currentSessionId = sessionId;
  let lastResultEvent = null;

  try {
    return await new Promise((resolve) => {
      const child = spawnImpl(executable.command, [...executable.prependArgs, ...args], {
        cwd, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (onSpawn) onSpawn(child);
      const timer = timeoutMs > 0 ? setTimeout(() => {
        timedOut = true;
        killProcessTree(child, platform);
      }, timeoutMs) : null;

      child.stdin?.on('error', () => {}); // EPIPE if the CLI exits early
      const handleRaw = (raw) => {
        for (const event of adapter.normalizeEvent(raw)) {
          if (event.type === 'session' && event.sessionId) currentSessionId = event.sessionId;
          if (event.type === 'result') lastResultEvent = event;
          if (event.type === 'error' && !errorMessage) errorMessage = event.message ?? 'error event';
          onEvent({ ...event, at: Date.now() });
        }
      };
      child.stdout?.on('data', (chunk) => {
        for (const raw of parser.push(chunk)) handleRaw(raw);
      });
      child.stderr?.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
      });
      child.on('error', (err) => { spawnError = err.message; });
      child.on('close', async (exitCode) => {
        if (timer) clearTimeout(timer);
        for (const raw of parser.end()) handleRaw(raw);
        const final = await adapter.finalize({
          exitCode, timedOut, spawnError, stderrTail, errorMessage,
          ...(adapter.supportsSchemaFile ? { lastMessagePath } : { lastResultEvent }),
        });
        onEvent({ type: 'exit', exitCode, timedOut, at: Date.now() });
        resolve({
          ok: !final.error,
          sessionId: currentSessionId,
          rawResult: final.rawResult ?? null,
          error: final.error ?? null,
          exitCode, timedOut, spawnError, stderrTail,
          attemptId: options.attemptId ?? null,
        });
      });

      child.stdin?.end(prompt, 'utf8');
    });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
