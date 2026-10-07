import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLI_PROFILES,
  GENERIC_PROFILE,
  detectCliProfile,
} from '../src/server/cli-profiles.js';

test('detects codex from a bare command', () => {
  const p = detectCliProfile('codex');
  assert.equal(p.id, 'codex');
  assert.equal(p.tui, true);
  assert.equal(p.suggestMode, 'stdin');
});

test('detects an agent through wrapper invocations', () => {
  assert.equal(detectCliProfile('npx.cmd', ['-y', 'claude-code']).id, 'claude');
  assert.equal(detectCliProfile('uvx', ['aider']).id, 'aider');
  assert.equal(detectCliProfile('pnpm', ['dlx', 'gemini']).id, 'gemini');
});

test('recognizes opencode and cline panes (Windows shim paths and npx wrappers)', () => {
  for (const [id, cmd] of [['opencode', 'opencode'], ['cline', 'cline']]) {
    const p = detectCliProfile(cmd);
    assert.equal(p.id, id);
    assert.equal(p.suggestMode, 'stdin');
    assert.notEqual(p.accent, GENERIC_PROFILE.accent);
    assert.equal(detectCliProfile(`C:\\Users\\admin\\AppData\\Roaming\\npm\\${cmd}.cmd`).id, id);
    assert.equal(detectCliProfile('npx', ['-y', cmd]).id, id);
  }
  // zcode has no verified interface: it must stay an unknown/display CLI.
  assert.equal(detectCliProfile('zcode').id, GENERIC_PROFILE.id);
});

test('detects Windows shells by full path', () => {
  assert.equal(detectCliProfile('C:\\Windows\\System32\\cmd.exe').id, 'shell');
  assert.equal(detectCliProfile('C:\\Program Files\\PowerShell\\7\\pwsh.exe').id, 'shell');
  assert.equal(detectCliProfile('/bin/bash').id, 'shell');
});

test('flags never masquerade as CLI names', () => {
  // `node -e …` must not match anything from the flag text
  const p = detectCliProfile(process.execPath, ['-e', 'process.stdout.write("codex claude gemini")']);
  assert.equal(p.id, 'node');
});

test('interpreters and shells keep the safe display default', () => {
  assert.equal(detectCliProfile(process.execPath).suggestMode, 'display');
  assert.equal(detectCliProfile('python3').suggestMode, 'display');
  assert.equal(detectCliProfile('pwsh').suggestMode, 'display');
  assert.equal(GENERIC_PROFILE.suggestMode, 'display');
});

test('every agent CLI suggests stdin and carries an accent', () => {
  const agents = CLI_PROFILES.filter((p) => p.suggestMode === 'stdin');
  assert.ok(agents.length >= 8, 'the registry covers the common agent CLIs');
  for (const p of agents) {
    assert.match(p.accent, /^#[0-9a-f]{6}$/i, `${p.id} has a hex accent`);
    assert.ok(p.note.length > 10, `${p.id} explains itself`);
  }
});

test('unknown commands fall back to the generic profile', () => {
  const p = detectCliProfile('totally-unknown-tool', ['--flag']);
  assert.equal(p, GENERIC_PROFILE);
  assert.equal(p.id, 'generic');
});

test('the registry has no duplicate names or ids', () => {
  const ids = new Set();
  const names = new Set();
  for (const p of CLI_PROFILES) {
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
    for (const n of p.names) {
      assert.ok(!names.has(n), `duplicate name ${n}`);
      names.add(n);
    }
  }
});
