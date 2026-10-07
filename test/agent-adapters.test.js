import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { codexAdapter, claudeAdapter, runTurn, detectCli } from '../src/server/agent-runtime/adapters.js';
import { buildResultSchema } from '../src/server/agent-runtime/result-schema.js';

const CWD = process.cwd();
const SCHEMA = buildResultSchema({ recipientIds: ['agent-a', 'agent-b'], messagesPerTurn: 4 });
const VALID_RESULT = {
  summary: 'did the thing', outcome: 'done', artifacts: [], checks: [],
  messages: [{ to: 'agent-b', text: 'over to you' }], followUps: [], question: null,
};

// ---------------------------------------------------------------------------
// buildArgs: exact argv, and never a dangerous flag
// ---------------------------------------------------------------------------

describe('codexAdapter.buildArgs', () => {
  it('fresh turn: stdin prompt, sandbox, schema file, last-message file', () => {
    const args = codexAdapter.buildArgs({ cwd: CWD, permissionProfile: 'read-only', sessionId: null, schemaPath: 'S.json', lastMessagePath: 'L.json' });
    assert.deepEqual(args, [
      'exec', '--json', '--color', 'never', '--skip-git-repo-check',
      '-C', CWD, '--sandbox', 'read-only',
      '--output-schema', 'S.json', '-o', 'L.json', '-',
    ]);
  });

  it('resume names the explicit session id and still reads stdin', () => {
    const args = codexAdapter.buildArgs({ cwd: CWD, permissionProfile: 'workspace-write', sessionId: 'ses-42', schemaPath: 'S.json', lastMessagePath: 'L.json' });
    assert.deepEqual(args.slice(0, 3), ['exec', 'resume', '--json']);
    assert.ok(args.includes('ses-42'));
    assert.equal(args[args.length - 1], '-');
    assert.ok(!args.includes('--last'));
    assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
  });

  it('an unknown profile degrades to read-only, never to danger', () => {
    const args = codexAdapter.buildArgs({ cwd: CWD, permissionProfile: 'workspace-write-please', sessionId: null, schemaPath: 'S', lastMessagePath: 'L' });
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  });
});

describe('claudeAdapter.buildArgs', () => {
  it('read-only uses plan mode and denies prompts', () => {
    const args = claudeAdapter.buildArgs({ cwd: CWD, permissionProfile: 'read-only', sessionId: null, schemaJson: '{}' });
    assert.deepEqual(args.slice(0, 12), [
      '-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'text',
      '--json-schema', '{}', '--permission-prompts', 'none', '--permission-mode', 'plan',
    ]);
    assert.deepEqual(args.slice(-2), ['--add-dir', CWD]);
  });

  it('workspace-write allows edits and names tools, still denies prompts', () => {
    const args = claudeAdapter.buildArgs({ cwd: CWD, permissionProfile: 'workspace-write', sessionId: null, schemaJson: '{}' });
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
    assert.ok(args.includes('--allowedTools'));
    assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  });

  it('resume passes the captured session id', () => {
    const args = claudeAdapter.buildArgs({ cwd: CWD, permissionProfile: 'read-only', sessionId: 'ses-9', schemaJson: '{}' });
    assert.deepEqual(args.slice(-2), ['--resume', 'ses-9']);
  });
});

describe('adapter argv safety', () => {
  it('never contains bypass, danger, or auto-approval flags', () => {
    const cases = [];
    for (const profile of ['read-only', 'workspace-write']) {
      for (const sessionId of [null, 'ses-1']) {
        cases.push(codexAdapter.buildArgs({ cwd: CWD, permissionProfile: profile, sessionId, schemaPath: 'S', lastMessagePath: 'L' }));
        cases.push(claudeAdapter.buildArgs({ cwd: CWD, permissionProfile: profile, sessionId, schemaJson: '{}' }));
      }
    }
    for (const args of cases) {
      assert.doesNotMatch(args.join(' '), /danger|bypass|approve-for-me|skip-permissions|--last\b/i);
    }
  });
});

describe('buildResultSchema', () => {
  it('pins message recipients to current run members', () => {
    const schema = buildResultSchema({ recipientIds: ['agent-a', 'agent-b'] });
    assert.deepEqual(schema.properties.messages.items.properties.to.enum, ['agent-a', 'agent-b']);
    assert.deepEqual(schema.properties.followUps.items.properties.assignee.enum, ['agent-a', 'agent-b']);
    assert.equal(schema.properties.messages.maxItems, 8);
    assert.deepEqual(schema.then.properties.question, { type: 'string', minLength: 1 });
  });

  it('allows a solo run with an empty recipient enum that matches nothing', () => {
    const schema = buildResultSchema({ recipientIds: [] });
    assert.deepEqual(schema.properties.messages.items.properties.to.enum, []);
    assert.throws(() => buildResultSchema({}), /current run participants/);
  });
});

// ---------------------------------------------------------------------------
// normalizeEvent: representative provider shapes -> unified vocabulary
// ---------------------------------------------------------------------------

describe('codexAdapter.normalizeEvent', () => {
  it('maps thread start, messages, commands, and errors', () => {
    assert.deepEqual(codexAdapter.normalizeEvent({ msg: { type: 'thread.started', thread_id: 'th-1' } }), [{ type: 'session', sessionId: 'th-1' }]);
    assert.deepEqual(codexAdapter.normalizeEvent({ msg: { type: 'agent_message', message: 'hi' } }), [{ type: 'text', text: 'hi' }]);
    const started = codexAdapter.normalizeEvent({ msg: { type: 'exec_command_begin', command: ['node', '-v'] } });
    assert.equal(started[0].type, 'tool');
    assert.equal(started[0].phase, 'started');
    assert.equal(started[0].detail, 'node -v');
    const ended = codexAdapter.normalizeEvent({ msg: { type: 'exec_command_end', exit_code: 0, stdout: 'v22' } });
    assert.equal(ended[0].status, 'ok');
  });

  it('classifies sandbox denials as permission_denied', () => {
    const events = codexAdapter.normalizeEvent({
      msg: { type: 'item.completed', item: { type: 'command_execution', status: 'failed', aggregated_output: 'sandbox: operation not permitted' } },
    });
    assert.ok(events.some((e) => e.type === 'permission_denied'));
    const err = codexAdapter.normalizeEvent({ msg: { type: 'error', message: 'approval required by sandbox' } });
    assert.equal(err[0].type, 'permission_denied');
  });

  it('passes unknown events through as bounded diagnostics and ignores bookkeeping', () => {
    const unknown = codexAdapter.normalizeEvent({ msg: { type: 'weird_future_event', payload: 'x'.repeat(9000) } });
    assert.equal(unknown[0].type, 'diagnostic');
    assert.ok(unknown[0].text.length <= 500);
    assert.deepEqual(codexAdapter.normalizeEvent({ msg: { type: 'token_count', info: {} } }), []);
  });
});

describe('claudeAdapter.normalizeEvent', () => {
  it('maps init, assistant blocks, tool results, and the final result', () => {
    assert.deepEqual(claudeAdapter.normalizeEvent({ type: 'system', subtype: 'init', session_id: 'ses-1' }), [{ type: 'session', sessionId: 'ses-1' }]);
    const assistant = claudeAdapter.normalizeEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'let me look' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.js' } }] },
    });
    assert.equal(assistant[0].type, 'text');
    assert.equal(assistant[1].type, 'tool');
    assert.equal(assistant[1].name, 'Read');
    const toolResult = claudeAdapter.normalizeEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body', is_error: false }] },
    });
    assert.equal(toolResult[0].status, 'ok');
    const result = claudeAdapter.normalizeEvent({ type: 'result', subtype: 'success', is_error: false, result: '{"a":1}', session_id: 'ses-1', num_turns: 3, total_cost_usd: 0.02 });
    assert.deepEqual(result.find((e) => e.type === 'result'), {
      type: 'result', subtype: 'success', isError: false, resultText: '{"a":1}', numTurns: 3, costUsd: 0.02,
    });
  });

  it('flags denied tool results as permission_denied', () => {
    const events = claudeAdapter.normalizeEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'Error: permission denied; this action requires approval', is_error: true }] },
    });
    assert.equal(events[0].status, 'error');
    assert.ok(events.some((e) => e.type === 'permission_denied'));
  });
});

// ---------------------------------------------------------------------------
// runTurn + detectCli against scripted fake CLIs (no model, no network)
// ---------------------------------------------------------------------------

const FAKE_CODEX = `
const fs = require('fs');
const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('codex-cli 0.99.0-fake\\n'); process.exit(0); }
const mode = process.env.FAKE_MODE || 'ok';
const outIdx = argv.indexOf('-o');
const lastMessagePath = outIdx >= 0 ? argv[outIdx + 1] : null;
if (!argv.includes('--output-schema')) { process.stderr.write('missing --output-schema\\n'); process.exit(2); }
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', () => {
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  process.stdout.write(JSON.stringify({ msg: { type: 'thread.started', thread_id: 'th-fake-1' } }) + '\\n');
  if (mode === 'garbage') {
    process.stdout.write('compiling...\\n');
    process.stdout.write(JSON.stringify({ msg: { type: 'agent_message', message: 'prompt was: ' + prompt } }).slice(0, 20));
    process.stdout.write('\\n' + JSON.stringify({ msg: { type: 'agent_message', message: 'recovered' } }) + '\\n');
  } else {
    process.stdout.write(JSON.stringify({ msg: { type: 'agent_message', message: 'prompt was: ' + prompt } }) + '\\n');
  }
  if (mode === 'fail') { process.stderr.write('model unavailable\\n'); process.exit(3); }
  if (mode === 'noresult') { process.exit(0); }
  const result = ${JSON.stringify(JSON.stringify(VALID_RESULT))};
  if (lastMessagePath) fs.writeFileSync(lastMessagePath, result);
  process.exit(0);
});
`;

const FAKE_CLAUDE = `
const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('9.9.9-fake (Claude Code)\\n'); process.exit(0); }
const mode = process.env.FAKE_MODE || 'ok';
if (!argv.includes('--json-schema')) { process.stderr.write('missing --json-schema\\n'); process.exit(2); }
if (!argv.includes('--permission-prompts') || argv[argv.indexOf('--permission-prompts') + 1] !== 'none') {
  process.stderr.write('permission prompts must be denied\\n'); process.exit(2);
}
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', () => {
  const write = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  write({ type: 'system', subtype: 'init', session_id: 'ses-fake-1' });
  write({ type: 'assistant', message: { content: [{ type: 'text', text: 'prompt was: ' + prompt }] } });
  if (mode === 'denied') {
    write({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't9', content: 'permission denied: requires approval', is_error: true }] } });
  }
  if (mode === 'noresult') { process.exit(0); }
  if (mode === 'errorresult') { write({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'ses-fake-1' }); process.exit(1); }
  const resultText = mode === 'badjson' ? 'not json at all' : ${JSON.stringify(JSON.stringify(VALID_RESULT))};
  write({ type: 'result', subtype: 'success', is_error: false, result: resultText, session_id: 'ses-fake-1', num_turns: 1, total_cost_usd: 0 });
  process.exit(0);
});
`;

let dir;
let codexExe;
let claudeExe;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'clihive-adapters-'));
  const codexScript = path.join(dir, 'fake-codex.cjs');
  const claudeScript = path.join(dir, 'fake-claude.cjs');
  await writeFile(codexScript, FAKE_CODEX, 'utf8');
  await writeFile(claudeScript, FAKE_CLAUDE, 'utf8');
  codexExe = { command: process.execPath, prependArgs: [codexScript] };
  claudeExe = { command: process.execPath, prependArgs: [claudeScript] };
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function turn(adapter, executable, mode, overrides = {}) {
  const events = [];
  const promise = runTurn(adapter, {
    executable,
    prompt: '任务：检查并汇报\n包含换行和 ünïcödé',
    cwd: dir,
    permissionProfile: 'read-only',
    schema: SCHEMA,
    timeoutMs: 20000,
    env: { ...process.env, FAKE_MODE: mode },
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { promise, events };
}

describe('runTurn with a scripted codex fake', () => {
  it('streams events, round-trips the stdin prompt, and returns the structured result', async () => {
    const { promise, events } = turn(codexAdapter, codexExe, 'ok');
    const outcome = await promise;
    assert.equal(outcome.ok, true);
    assert.equal(outcome.error, null);
    assert.equal(outcome.sessionId, 'th-fake-1');
    assert.deepEqual(outcome.rawResult, VALID_RESULT);
    assert.equal(outcome.exitCode, 0);
    const text = events.find((e) => e.type === 'text');
    assert.ok(text.text.includes('任务：检查并汇报'));
    assert.ok(text.text.includes('ünïcödé'));
    assert.ok(events.some((e) => e.type === 'session'));
    assert.equal(events[events.length - 1].type, 'exit');
    assert.ok(events.every((e) => typeof e.at === 'number'));
  });

  it('survives garbage lines and split JSON in the stream', async () => {
    const { promise, events } = turn(codexAdapter, codexExe, 'garbage');
    const outcome = await promise;
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.rawResult, VALID_RESULT);
    assert.ok(events.some((e) => e.type === 'text' && e.text === 'recovered'));
  });

  it('reports a nonzero exit as an error with the stderr tail', async () => {
    const { promise } = turn(codexAdapter, codexExe, 'fail');
    const outcome = await promise;
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /exited with code 3/);
    assert.match(outcome.stderrTail, /model unavailable/);
    assert.equal(outcome.rawResult, null);
  });

  it('reports exit 0 without a result file as an error, not success', async () => {
    const { promise } = turn(codexAdapter, codexExe, 'noresult');
    const outcome = await promise;
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /no final message file/);
  });

  it('kills the process tree on timeout and reports it', async () => {
    const { promise } = turn(codexAdapter, codexExe, 'hang', { timeoutMs: 1500 });
    const outcome = await promise;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.timedOut, true);
    assert.match(outcome.error, /timed out/);
  });
});

describe('runTurn with a scripted claude fake', () => {
  it('returns the structured result from the result event and captures the session id', async () => {
    const { promise, events } = turn(claudeAdapter, claudeExe, 'ok');
    const outcome = await promise;
    assert.equal(outcome.ok, true);
    assert.equal(outcome.sessionId, 'ses-fake-1');
    assert.deepEqual(outcome.rawResult, VALID_RESULT);
    assert.ok(events.some((e) => e.type === 'result'));
  });

  it('surfaces denied permissions as permission_denied events', async () => {
    const { promise, events } = turn(claudeAdapter, claudeExe, 'denied');
    const outcome = await promise;
    assert.equal(outcome.ok, true);
    assert.ok(events.some((e) => e.type === 'permission_denied'));
  });

  it('treats a missing result event as failure even on exit 0', async () => {
    const { promise } = turn(claudeAdapter, claudeExe, 'noresult');
    const outcome = await promise;
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /without a result event/);
  });

  it('treats an error result event as failure', async () => {
    const { promise } = turn(claudeAdapter, claudeExe, 'errorresult');
    const outcome = await promise;
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /error_during_execution/);
  });

  it('treats unparsable structured output as failure', async () => {
    const { promise } = turn(claudeAdapter, claudeExe, 'badjson');
    const outcome = await promise;
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /not valid JSON/);
  });
});

describe('detectCli', () => {
  it('reports an available CLI with its version line', async () => {
    const result = await detectCli(codexExe);
    assert.deepEqual(result, { available: true, version: 'codex-cli 0.99.0-fake' });
  });

  it('reports a CLI that fails to spawn as unavailable, without throwing', async () => {
    const result = await detectCli({ command: path.join(dir, 'definitely-missing.exe'), prependArgs: [] });
    assert.equal(result.available, false);
    assert.ok(result.reason.length > 0);
  });
});
