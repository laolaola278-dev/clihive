import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { opencodeAdapter, ADAPTERS, runTurn, stripJsonFence, extractJsonObject } from '../src/server/agent-runtime/adapters.js';
import { buildResultSchema } from '../src/server/agent-runtime/result-schema.js';
import { validateAgentInput, MANAGED_PROVIDERS } from '../src/server/collaboration-validation.js';

const CWD = process.cwd();
const VALID = {
  summary: 'ok', outcome: 'done', artifacts: [], checks: [], messages: [], followUps: [], question: null,
};

describe('opencodeAdapter.buildArgs / buildEnv', () => {
  it('read-only uses the plan agent, stdin prompt, pure mode, json events', () => {
    const args = opencodeAdapter.buildArgs({ cwd: CWD, permissionProfile: 'read-only', sessionId: null });
    assert.deepEqual(args, ['run', '--pure', '--format', 'json', '--agent', 'plan', '--dir', CWD]);
  });

  it('workspace-write uses build; model and session are explicit single argv elements', () => {
    const args = opencodeAdapter.buildArgs({ cwd: CWD, permissionProfile: 'workspace-write', sessionId: 'ses_1', model: 'openrouter/deepseek/deepseek-chat' });
    assert.equal(args[args.indexOf('--agent') + 1], 'build');
    assert.equal(args[args.indexOf('-m') + 1], 'openrouter/deepseek/deepseek-chat');
    assert.equal(args[args.indexOf('-s') + 1], 'ses_1');
  });

  it('never passes auto-approve / danger flags', () => {
    for (const profile of ['read-only', 'workspace-write', 'anything-else']) {
      const args = opencodeAdapter.buildArgs({ cwd: CWD, permissionProfile: profile, sessionId: 's', model: 'a/b' });
      assert.ok(!args.some((a) => /auto|dangerous|bypass|yolo|skip-permissions/i.test(a)), args.join(' '));
      assert.ok(!args.includes('--attach'));
    }
  });

  it('permissions travel in OPENCODE_CONFIG_CONTENT: read-only denies edit+bash, write allows them, web and external dirs always denied', () => {
    const ro = JSON.parse(opencodeAdapter.buildEnv({ permissionProfile: 'read-only' }).OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(ro.permission, { edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny' });
    const ww = JSON.parse(opencodeAdapter.buildEnv({ permissionProfile: 'workspace-write' }).OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(ww.permission, { edit: 'allow', bash: 'allow', webfetch: 'deny', external_directory: 'deny' });
    const unknown = JSON.parse(opencodeAdapter.buildEnv({ permissionProfile: 'weird' }).OPENCODE_CONFIG_CONTENT);
    assert.equal(unknown.permission.edit, 'deny');
  });
});

describe('opencodeAdapter.normalizeEvent (shapes captured from opencode 1.18.34)', () => {
  const ses = 'ses_abc';
  it('captures the session id and text as a candidate result', () => {
    const out = opencodeAdapter.normalizeEvent({ type: 'text', sessionID: ses, part: { type: 'text', text: '{"a":1}' } });
    assert.deepEqual(out.map((e) => e.type), ['session', 'text', 'result']);
    assert.equal(out[0].sessionId, ses);
    assert.equal(out[2].resultText, '{"a":1}');
  });

  it('maps tool_use and flags a denied tool call as permission_denied', () => {
    const out = opencodeAdapter.normalizeEvent({
      type: 'tool_use', sessionID: ses,
      part: { type: 'tool', tool: 'write', callID: 'c1', state: { status: 'error', input: { filePath: 'x' }, error: 'The user has specified a rule which prevents you from using this specific tool call.' } },
    });
    assert.ok(out.some((e) => e.type === 'tool' && e.status === 'error' && e.name === 'write'));
    assert.ok(out.some((e) => e.type === 'permission_denied'));
  });

  it('an ordinary failed read (file not found) is not a permission denial', () => {
    const out = opencodeAdapter.normalizeEvent({
      type: 'tool_use', sessionID: ses,
      part: { type: 'tool', tool: 'read', state: { status: 'error', input: {}, error: 'File not found: X' } },
    });
    assert.ok(!out.some((e) => e.type === 'permission_denied'));
  });

  it('maps provider errors to error events and ignores step markers', () => {
    const err = opencodeAdapter.normalizeEvent({ type: 'error', sessionID: ses, error: { name: 'APIError', data: { message: 'Authentication Fails' } } });
    assert.ok(err.some((e) => e.type === 'error' && /Authentication Fails/.test(e.message)));
    const step = opencodeAdapter.normalizeEvent({ type: 'step_start', sessionID: ses, part: {} });
    assert.deepEqual(step.map((e) => e.type), ['session']);
  });
});

describe('opencodeAdapter.finalize', () => {
  it('parses the last text as the structured result, tolerating a json fence', async () => {
    const plain = await opencodeAdapter.finalize({ exitCode: 0, lastResultEvent: { resultText: JSON.stringify(VALID) } });
    assert.deepEqual(plain.rawResult, VALID);
    const fenced = await opencodeAdapter.finalize({ exitCode: 0, lastResultEvent: { resultText: `\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\`` } });
    assert.deepEqual(fenced.rawResult, VALID);
    assert.equal(stripJsonFence('  {"x":1} '), '{"x":1}');
  });

  it('fails closed: provider error, non-zero exit, timeout, no text, prose instead of JSON', async () => {
    assert.match((await opencodeAdapter.finalize({ exitCode: 1, errorMessage: 'Authentication Fails', lastResultEvent: null })).error, /Authentication Fails/);
    assert.match((await opencodeAdapter.finalize({ exitCode: 2, stderrTail: 'boom', lastResultEvent: { resultText: '{}' } })).error, /exited with code 2/);
    assert.match((await opencodeAdapter.finalize({ exitCode: null, timedOut: true })).error, /timed out/);
    assert.match((await opencodeAdapter.finalize({ exitCode: 0, lastResultEvent: null })).error, /without a final text/);
    assert.match((await opencodeAdapter.finalize({ exitCode: 0, lastResultEvent: { resultText: 'All done!' } })).error, /not a valid JSON object/);
  });

  it('extracts the object from the packaging real models produce', async () => {
    const F = '```';
    const body = JSON.stringify(VALID, null, 2);
    const shapes = {
      bare: body,
      fenced: `${F}json\n${body}\n${F}`,
      fencedCrlf: `${F}json\r\n${body}\r\n${F}`,
      bareFence: `${F}\n${body}\n${F}`,
      proseBefore: `Here is my result:\n${F}json\n${body}\n${F}\nHope that helps.`,
      proseAround: `Result follows. ${body} That is all.`,
      strayLabel: `json\n${body}`,
    };
    for (const [name, text] of Object.entries(shapes)) {
      const out = await opencodeAdapter.finalize({ exitCode: 0, lastResultEvent: { resultText: text } });
      assert.deepEqual(out.rawResult, VALID, name);
    }
    assert.equal(extractJsonObject('[1,2,3]').value, null, 'arrays are not results');
    assert.equal(extractJsonObject('').value, null);
  });
});

describe('opencode registration', () => {
  it('is a registered managed provider with an adapter', () => {
    assert.ok(MANAGED_PROVIDERS.includes('opencode'));
    assert.equal(ADAPTERS.opencode, opencodeAdapter);
  });

  it('accepts a safe model only for opencode', () => {
    const ok = validateAgentInput({ provider: 'opencode', cwd: CWD, model: 'openrouter/deepseek/deepseek-chat' });
    assert.equal(ok.model, 'openrouter/deepseek/deepseek-chat');
    assert.equal(validateAgentInput({ provider: 'opencode', cwd: CWD }).model, undefined);
    assert.throws(() => validateAgentInput({ provider: 'codex', cwd: CWD, model: 'a/b' }), /only supported for opencode/);
    for (const bad of ['--auto', 'a b', 'a/b;rm -rf', '$(x)', '-m']) {
      assert.throws(() => validateAgentInput({ provider: 'opencode', cwd: CWD, model: bad }), /provider\/model/, bad);
    }
    assert.throws(() => validateAgentInput({ provider: 'cline', cwd: CWD }), /support only/);
  });
});

describe('runTurn with an opencode-shaped process', () => {
  it('feeds the prompt on stdin, applies the permission env, and returns the parsed result + session', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-test-'));
    try {
      const script = path.join(dir, 'fake-opencode.js');
      await writeFile(script, `
        let input = '';
        process.stdin.on('data', (c) => { input += c; });
        process.stdin.on('end', () => {
          const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
          const result = { summary: 'saw:' + input.trim() + ' edit=' + cfg.permission.edit + ' args=' + process.argv.slice(2).join(' '), outcome: 'done', artifacts: [], checks: [], messages: [], followUps: [], question: null };
          const ev = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
          ev({ type: 'step_start', sessionID: 'ses_fake', part: {} });
          ev({ type: 'text', sessionID: 'ses_fake', part: { type: 'text', text: JSON.stringify(result) } });
          ev({ type: 'step_finish', sessionID: 'ses_fake', part: {} });
        });
      `);
      const events = [];
      const out = await runTurn(opencodeAdapter, {
        executable: { command: process.execPath, prependArgs: [script] },
        prompt: 'PROMPT-BODY', cwd: dir, permissionProfile: 'read-only', model: 'x/y',
        schema: buildResultSchema({ recipientIds: [] }), timeoutMs: 20000,
        onEvent: (e) => events.push(e.type),
      });
      assert.equal(out.ok, true, out.error);
      assert.equal(out.sessionId, 'ses_fake');
      assert.match(out.rawResult.summary, /saw:PROMPT-BODY edit=deny/);
      assert.match(out.rawResult.summary, /--agent plan/);
      assert.match(out.rawResult.summary, /-m x\/y/);
      assert.ok(events.includes('exit'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a provider error event fails the turn even if the process exits 0', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-test-'));
    try {
      const script = path.join(dir, 'fake-opencode.js');
      await writeFile(script, `
        process.stdin.resume(); process.stdin.on('end', () => {
          process.stdout.write(JSON.stringify({ type: 'error', sessionID: 's', error: { name: 'APIError', data: { message: 'Authentication Fails' } } }) + '\\n');
        });
      `);
      const out = await runTurn(opencodeAdapter, {
        executable: { command: process.execPath, prependArgs: [script] },
        prompt: 'p', cwd: dir, schema: buildResultSchema({ recipientIds: [] }), timeoutMs: 20000,
      });
      assert.equal(out.ok, false);
      assert.match(out.error, /Authentication Fails/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
