import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OutputModeTracker } from '../src/server/output-modes.js';

test('output mode tracker: plain shell stream stays default', () => {
  const t = new OutputModeTracker();
  t.feed('hello world\r\n', 13);
  assert.equal(t.altScreen, false);
  assert.equal(t.preamble(0), '');
});

test('output mode tracker: alt screen is detected from the byte stream', () => {
  const t = new OutputModeTracker();
  t.feed('$ codex\r\n', 8);
  t.feed('\x1b[?1049h\x1b[2J\x1b[HFRAME', 28);
  assert.equal(t.altScreen, true);
});

test('output mode tracker: leaving alt screen clears the flag', () => {
  const t = new OutputModeTracker();
  t.feed('\x1b[?1049h\x1b[Hframe', 18);
  assert.equal(t.altScreen, true);
  t.feed('\x1b[?1049l$ ', 28);
  assert.equal(t.altScreen, false);
});

test('preamble: empty when the entry is inside the window (launched a moment ago)', () => {
  const t = new OutputModeTracker();
  // The window starts before the entry, so it already contains it: asserting a
  // second entry would paint the preceding scrollback into the alternate buffer.
  t.feed('$ vim', 5);
  t.feed('\x1b[?1049h\x1b[HEditing', 23);
  assert.equal(t.preamble(0), '');
});

test('preamble: re-asserted when the entry scrolled out of the window', () => {
  const t = new OutputModeTracker();
  t.feed('$ codex\x1b[?1049h\x1b[2J\x1b[HFULLSCREEN-FRAME', 41);
  // A window that starts AFTER the entry no longer contains it: the viewer would
  // otherwise stay on the normal buffer while absolute frames assume the
  // alternate one. The preamble puts it back.
  const p = t.preamble(30);
  assert.ok(p.startsWith('\x1b[?1049h'), `preamble should assert alt screen, got ${JSON.stringify(p)}`);
  assert.ok(p.includes('\x1b[2J\x1b[H'), 'preamble should blank + home the screen');
});

test('preamble: mouse reporting is re-asserted only when it is on', () => {
  const t = new OutputModeTracker();
  t.feed('\x1b[?1003h\x1b[?1006h', 16);
  const p = t.preamble(0);
  assert.ok(p.includes('\x1b[?1003h'), 'preamble should assert mouse tracking');
  assert.ok(p.includes('\x1b[?1006h'), 'preamble should assert SGR mouse encoding');
});

test('mode sequence split across a chunk boundary is not lost', () => {
  const t = new OutputModeTracker();
  t.feed('$ c', 3);
  t.feed('odex\x1b[?104', 14);

  // final `9h` in the next chunk completes the sequence
  t.feed('9h\x1b[HFRAME', 22);
  assert.equal(t.altScreen, true);
});

test('DECSTR soft reset clears modes but keeps the alternate screen', () => {
  const t = new OutputModeTracker();
  t.feed('\x1b[?1003h\x1b[?1049h\x1b[H', 23);
  assert.equal(t.altScreen, true);
  t.feed('\x1b[!p', 27);
  assert.equal(t.altScreen, true, 'a soft reset does not leave the alternate buffer');
  assert.equal(t.isSet(1003), false, 'a soft reset clears mouse tracking');
});

test('RIS resets everything including the alternate screen', () => {
  const t = new OutputModeTracker();
  t.feed('\x1b[?1049h\x1b[?1003h', 19);
  t.feed('\x1bc', 22);
  assert.equal(t.altScreen, false);
  assert.equal(t.isSet(1003), false);
});

test('a legacy 47 entry is asserted as 47, not normalised to 1049', () => {
  const t = new OutputModeTracker();
  t.feed('\x1b[?47h\x1b[Hlegacy frame', 25);
  assert.equal(t.altScreen, true);
  assert.ok(t.preamble(20).includes('\x1b[?47h'), 'should replay the mode the stream really used');
});