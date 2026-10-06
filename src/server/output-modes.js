// Live tracker for the terminal modes a pane's output stream has switched on.
//
// Why this exists: a full-screen TUI (codex, claude, vim, less) sends
// `ESC[?1049h` ONCE at startup and then repaints forever with absolute cursor
// positioning. The scrollback ring only keeps the last 256 KB, so a client that
// attaches later — or a window that reloads — replays bytes whose alt-screen
// entry scrolled out of the window. The client's terminal is then still on the
// NORMAL buffer while the incoming frames assume the alternate one, so
// absolute-positioned frames land interleaved over each other and over the
// scrollback instead of repainting one screen. That interleave is the
// "overlapping context" a TUI pane shows.
//
// The fix is to reconstruct the mode state from the stream and prepend a
// preamble that puts a fresh terminal into the same state before the window's
// bytes are painted.
//
// Mode state is tracked HERE, on the byte stream, rather than read from the
// browser's terminal object: on Windows the PTY runs through ConPTY, which
// consumes the child's `?1049h` and renders the TUI itself, so the client-side
// buffer type never reports "alternate" and cannot be trusted as the signal.

/**
 * Tracked DEC private modes and their power-on defaults. A mode sitting at its
 * default contributes nothing to a preamble. Only modes that change how
 * SUBSEQUENT bytes are interpreted are tracked — colours, charsets and cursor
 * position are carried by the window's own bytes.
 * @type {Map<number, boolean>}
 */
const MODE_DEFAULTS = new Map([
  [1, false], // DECCKM — application cursor keys
  [7, true], // DECAWM — autowrap
  [25, true], // DECTCEM — cursor visible
  [47, false], // alternate screen (legacy)
  [1047, false], // alternate screen (clear on exit)
  [1049, false], // alternate screen + saved cursor — what modern TUIs use
  [1000, false], // mouse: normal tracking
  [1002, false], // mouse: button-event tracking
  [1003, false], // mouse: any-event tracking
  [1005, false], // mouse encoding: UTF-8
  [1006, false], // mouse encoding: SGR
  [1015, false], // mouse encoding: urxvt
  [2004, false], // bracketed paste
]);

/** The alt-screen modes, in the order a preamble should assert them. */
const ALT_SCREEN_MODES = [47, 1047, 1049];

/**
 * Characters kept across feeds so a mode sequence split across a chunk boundary
 * still matches. A full mouse-mode declaration can run past 60 chars, so 256
 * leaves real margin.
 */
const CARRY_CHARS = 256;

/**
 * DEC private mode set/reset (`CSI ? Ps;Ps h|l`), RIS (`ESC c`) and DECSTR soft
 * reset (`CSI ! p`), matched together so a reset between two set-modes is
 * applied in stream order. DECSTR matters because terminfo's `rs2` — what
 * `reset` and `tput init` send — is literally `ESC[!p`.
 */
const MODE_RE = /\x1b(?:\[\?([0-9;]*)([hl])|\[!p|c)/g;

const RIS = '\x1bc';

export class OutputModeTracker {
  constructor() {
    /** @type {string} */
    this.carry = '';
    /** @type {Map<number, boolean>} */
    this.state = new Map(MODE_DEFAULTS);
    /**
     * Absolute stream offset (in characters, the ring's own coordinate system)
     * of the most recent alt-screen ENTRY, and which mode performed it.
     * -1 until one is seen.
     */
    this.lastAltEntryOffset = -1;
    this.lastAltEntryMode = 0;
  }

  /**
   * Feed one decoded output chunk, in stream order.
   * @param {string} chunk
   * @param {number} streamEndOffset total chars emitted AFTER this chunk
   *
   * The carry re-scans at most CARRY_CHARS per chunk so a boundary inside a
   * sequence does not lose it. A sequence spanning the boundary matches once,
   * on the feed that completes it: the earlier feed saw no final `h`/`l`.
   */
  feed(chunk, streamEndOffset) {
    if (!chunk) return;
    const text = this.carry + chunk;
    MODE_RE.lastIndex = 0;
    let altEntryIndex = -1;
    let match;
    while ((match = MODE_RE.exec(text)) !== null) {
      if (match[1] === undefined) {
        if (match[0] === RIS) this.reset();
        else this.#softReset();
        continue;
      }
      const on = match[2] === 'h';
      for (const raw of match[1].split(';')) {
        if (raw === '') continue;
        const mode = Number(raw);
        if (!Number.isFinite(mode) || !this.state.has(mode)) continue;
        // Last writer wins per mode: toggling 1049 a hundred times leaves
        // whatever the final sequence asked for.
        this.state.set(mode, on);
        if (on && ALT_SCREEN_MODES.includes(mode)) {
          altEntryIndex = match.index;
          this.lastAltEntryMode = mode;
        }
      }
    }
    if (altEntryIndex >= 0) {
      // The carry is a verbatim suffix of the previous chunk, so subtracting
      // the distance from the entry to the end of `text` is exact even when the
      // sequence began before this chunk.
      this.lastAltEntryOffset = streamEndOffset - (text.length - altEntryIndex);
    }
    this.carry = text.slice(-CARRY_CHARS);
  }

  /** Back to power-on defaults, as RIS (`ESC c`) does to a real terminal. */
  reset() {
    for (const [mode, def] of MODE_DEFAULTS) this.state.set(mode, def);
    this.lastAltEntryOffset = -1;
    this.lastAltEntryMode = 0;
  }

  /**
   * DECSTR soft reset: everything tracked returns to default EXCEPT the
   * alt-screen modes. A soft reset does not swap the screen buffer back, so
   * claiming it did would drop a live TUI's viewer onto the normal buffer while
   * the stream keeps painting absolute frames.
   */
  #softReset() {
    for (const [mode, def] of MODE_DEFAULTS) {
      if (ALT_SCREEN_MODES.includes(mode)) continue;
      this.state.set(mode, def);
    }
  }

  /** Current value of one tracked mode (default for anything untracked). */
  isSet(mode) {
    return this.state.get(mode) ?? MODE_DEFAULTS.get(mode) ?? false;
  }

  /** True while the stream is painting into an alternate screen buffer. */
  get altScreen() {
    return ALT_SCREEN_MODES.some((m) => this.state.get(m) === true);
  }

  /**
   * The alt-screen mode actually in effect: the one that last ENTERED it when
   * still set, otherwise whichever remains. Replaying the mode the stream really
   * used (instead of normalising to 1049) keeps a later `ESC[?47l` inside the
   * window meaning what it meant on the remote.
   */
  #activeAltMode() {
    if (this.state.get(this.lastAltEntryMode) === true) return this.lastAltEntryMode;
    return ALT_SCREEN_MODES.find((m) => this.state.get(m) === true) ?? null;
  }

  /**
   * A sequence that puts a fresh terminal into the mode state this stream is
   * really in, to be PREPENDED to a capped replay window. Empty when every
   * tracked mode is at its default, so a plain shell session is byte-identical
   * to before this existed.
   *
   * @param {number} windowStartOffset absolute offset of the window's FIRST char
   *
   * The offset gates only the alt-screen half, because that half is the one that
   * is not idempotent. When the window ALREADY CONTAINS the app's own entry —
   * the ordinary "launched codex a moment ago" case — asserting it first would
   * paint the shell scrollback that precedes it INTO the alternate buffer; the
   * window's own entry then no-ops, and the app's eventual `ESC[?1049l` drops
   * the viewer on an empty normal buffer with the scrollback gone. So the entry
   * is asserted only when it fell outside the window. This is an offset
   * comparison, not a "was it truncated" flag: the ring wraps, and an entry lost
   * to the wrap is just as absent.
   *
   * Alt screen is asserted first, then erase + cursor home: the window that
   * follows came from an app that owns the whole screen and repaints by
   * absolute position, so it must start from a known-blank grid.
   *
   * Accepted limitation: an alt-screen app idle since before the window starts
   * contributes no repaint of its own, so the viewer shows only the part of the
   * frame the window happens to contain until the app next redraws. Mostly-right
   * beats the garbled interleave this replaces.
   */
  preamble(windowStartOffset) {
    let out = '';
    const alt = this.#activeAltMode();
    if (alt !== null && this.lastAltEntryOffset < windowStartOffset) {
      out += `\x1b[?${alt}h\x1b[2J\x1b[H`;
    }
    for (const [mode, def] of MODE_DEFAULTS) {
      if (ALT_SCREEN_MODES.includes(mode)) continue; // handled above
      const value = this.state.get(mode) ?? def;
      if (value === def) continue;
      out += `\x1b[?${mode}${value ? 'h' : 'l'}`;
    }
    return out;
  }
}

export const __test = { MODE_DEFAULTS, ALT_SCREEN_MODES, CARRY_CHARS };
