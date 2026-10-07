// Unit tests for the shared protocol: validation, addressing, formatting.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADDRESS_ALL,
  ADDRESS_HUMAN,
  ADDRESS_ORCHESTRATOR,
  MESSAGE_KINDS,
  DELIVERY_MODES,
  ProtocolError,
  normalizeMessage,
  isAddress,
  isVisibleTo,
  resolveTargets,
  formatForPty,
  stripAnsi,
  clampInt,
  makeId,
} from '../src/shared/protocol.js';

describe('normalizeMessage', () => {
  it('fills defaults', () => {
    const msg = normalizeMessage({ from: 'p1', text: 'hello' });
    assert.equal(msg.to, ADDRESS_ALL);
    assert.equal(msg.kind, MESSAGE_KINDS.CHAT);
    assert.ok(msg.id.startsWith('msg_'));
    assert.ok(Number.isFinite(msg.ts));
  });

  it('rejects empty text', () => {
    assert.throws(() => normalizeMessage({ from: 'p1', text: '   ' }), ProtocolError);
    assert.throws(() => normalizeMessage({ from: 'p1', text: '' }), ProtocolError);
  });

  it('rejects a bad from', () => {
    assert.throws(() => normalizeMessage({ from: '', text: 'x' }), ProtocolError);
    assert.throws(() => normalizeMessage({ from: 'has space', text: 'x' }), ProtocolError);
  });

  it('rejects an unknown kind', () => {
    assert.throws(() => normalizeMessage({ from: 'p1', text: 'x', kind: 'nope' }), ProtocolError);
  });

  it('rejects oversized text', () => {
    assert.throws(() => normalizeMessage({ from: 'p1', text: 'x'.repeat(70000) }), ProtocolError);
  });

  it('clones meta', () => {
    const meta = { a: 1 };
    const msg = normalizeMessage({ from: 'p1', text: 'x', meta });
    assert.deepEqual(msg.meta, meta);
    assert.notEqual(msg.meta, meta);
  });
});

describe('isAddress', () => {
  it('accepts reserved and pane-like ids', () => {
    for (const a of [ADDRESS_ALL, ADDRESS_ORCHESTRATOR, ADDRESS_HUMAN, 'p1', 'cli-3', 'a_b:c']) {
      assert.ok(isAddress(a), a);
    }
  });
  it('rejects junk', () => {
    for (const a of ['', '  ', 'a b', 'a\nb', null, undefined, 42]) {
      assert.ok(!isAddress(a), String(a));
    }
  });
});

describe('resolveTargets', () => {
  const panes = ['p1', 'p2', 'p3'];

  it('all = every pane except the sender', () => {
    assert.deepEqual(resolveTargets({ from: 'p1', to: 'all' }, panes), ['p2', 'p3']);
  });
  it('a specific pane resolves to itself', () => {
    assert.deepEqual(resolveTargets({ from: 'p1', to: 'p2' }, panes), ['p2']);
  });
  it('an unknown pane resolves to nothing', () => {
    assert.deepEqual(resolveTargets({ from: 'p1', to: 'p9' }, panes), []);
  });
  it('orchestrator / human stay virtual', () => {
    assert.deepEqual(resolveTargets({ from: 'p1', to: 'orchestrator' }, panes), ['orchestrator']);
    assert.deepEqual(resolveTargets({ from: 'p1', to: 'human' }, panes), ['human']);
  });
});

describe('isVisibleTo', () => {
  it('a pane sees broadcasts and its own direct messages', () => {
    assert.ok(isVisibleTo({ from: 'p1', to: 'all' }, 'p2'));
    assert.ok(isVisibleTo({ from: 'p1', to: 'p2' }, 'p2'));
    assert.ok(isVisibleTo({ from: 'p2', to: 'p1' }, 'p1'));
  });
  it('a pane does not see another pane private orchestrator instruction', () => {
    assert.ok(!isVisibleTo({ from: 'orchestrator', to: 'p2' }, 'p1'));
  });
  it('reports to the orchestrator are shared so peers can follow', () => {
    assert.ok(isVisibleTo({ from: 'p1', to: 'orchestrator' }, 'p2'));
  });
});

describe('formatForPty', () => {
  const msg = { id: 'msg_x', from: 'p1', to: 'all', kind: 'chat', text: 'hi\nthere' };

  it('stdin mode uses newlines for the prompt', () => {
    const out = formatForPty(msg, { label: 'beta', mode: DELIVERY_MODES.STDIN });
    assert.match(out, /^\[hive beta\] chat from p1 to all \(msg_x\)\n/);
    assert.ok(out.includes('hi\nthere\n'));
    assert.ok(!out.includes('['), 'stdin block has no ansi');
  });

  it('stdin mode with eol CR terminates every line like Enter (ConPTY)', () => {
    // Windows ConPTY buffers typed input until it sees CR; a lone LF never
    // reaches the child process. The win32 caller passes eol:'\r'.
    const out = formatForPty(msg, { label: 'beta', mode: DELIVERY_MODES.STDIN, eol: '\r' });
    assert.ok(out.includes('(msg_x)\r'), 'header line ends with CR');
    assert.ok(out.includes('hi\rthere\r'), 'body lines end with CR');
    assert.ok(!out.includes('\n'), 'no bare LF remains');
  });

  it('display mode uses CRLF and dims the header', () => {
    const out = formatForPty(msg, { label: 'beta', mode: DELIVERY_MODES.DISPLAY });
    assert.ok(out.includes('\r\n'));
    assert.ok(out.includes(''), 'display block uses ansi dim');
    assert.ok(stripAnsi(out).includes('[hive beta] chat from p1 to all (msg_x)'));
    assert.ok(stripAnsi(out).includes('hi\r\nthere'));
  });
});

describe('stripAnsi', () => {
  it('removes CSI and OSC sequences', () => {
    assert.equal(stripAnsi('[2mhello[0m'), 'hello');
    assert.equal(stripAnsi('[?25hx'), 'x');
    assert.equal(stripAnsi('plain'), 'plain');
  });
});

describe('clampInt', () => {
  it('clamps and falls back', () => {
    assert.equal(clampInt(50, 1, 100, 10), 50);
    assert.equal(clampInt(500, 1, 100, 10), 100);
    assert.equal(clampInt(-5, 1, 100, 10), 1);
    assert.equal(clampInt('nope', 1, 100, 10), 10);
  });
});

describe('makeId', () => {
  it('makes unique prefixed ids', () => {
    const a = makeId('msg');
    const b = makeId('msg');
    assert.ok(a.startsWith('msg_'));
    assert.notEqual(a, b);
  });
});
