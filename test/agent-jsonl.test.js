import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JsonlParser } from '../src/server/agent-runtime/jsonl.js';

function feed(parser, string) {
  return parser.push(Buffer.from(string, 'utf8'));
}

describe('JsonlParser', () => {
  it('parses complete newline-delimited objects', () => {
    const p = new JsonlParser();
    assert.deepEqual(feed(p, '{"a":1}\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  });

  it('holds a partial line until its newline arrives', () => {
    const p = new JsonlParser();
    assert.deepEqual(feed(p, '{"a"'), []);
    assert.deepEqual(feed(p, ':1}\n'), [{ a: 1 }]);
  });

  it('reassembles a UTF-8 character split across chunks', () => {
    const p = new JsonlParser();
    const bytes = Buffer.from('{"t":"汉"}\n', 'utf8');
    const first = p.push(bytes.subarray(0, 8)); // cuts inside 汉
    assert.deepEqual(first, []);
    assert.deepEqual(p.push(bytes.subarray(8)), [{ t: '汉' }]);
  });

  it('tolerates CRLF and blank lines', () => {
    const p = new JsonlParser();
    assert.deepEqual(feed(p, '\r\n{"a":1}\r\n\n'), [{ a: 1 }]);
  });

  it('counts and keeps bounded diagnostics for garbage lines', () => {
    const p = new JsonlParser();
    const out = feed(p, 'spinner...\n{"ok":true}\n{bad json}\n');
    assert.deepEqual(out, [{ ok: true }]);
    assert.equal(p.parseFailures, 2);
    assert.equal(p.skipped.length, 2);
    assert.equal(p.skipped[0].reason, 'not-json');
  });

  it('flushes a trailing object that has no final newline', () => {
    const p = new JsonlParser();
    assert.deepEqual(feed(p, '{"a":1}'), []);
    assert.deepEqual(p.end(), [{ a: 1 }]);
  });

  it('drops a runaway line instead of growing forever', () => {
    const p = new JsonlParser({ maxLineBytes: 32 });
    const out = p.push(Buffer.from('x'.repeat(100), 'utf8'));
    assert.deepEqual(out, []);
    assert.equal(p.parseFailures, 1);
    assert.equal(p.skipped[0].reason, 'oversized-tail');
  });

  it('caps the number of retained skipped lines', () => {
    const p = new JsonlParser();
    feed(p, Array.from({ length: 40 }, (_, i) => `bad${i}\n`).join(''));
    assert.equal(p.skipped.length, 20);
    assert.equal(p.parseFailures, 40);
  });
});
