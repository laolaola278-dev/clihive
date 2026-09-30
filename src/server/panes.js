// Pane manager: one small CLI window each.
//
// A pane owns a PTY, a bounded scrollback ring, and its identity on the bus.
//
// How a pane receives a hive message depends on its delivery mode:
//   - `display` (default): the message is painted into the pane's viewport.
//     The child process is untouched, so a plain shell never tries to execute
//     it. The human reads it; an agent picks it up with `hive inbox`.
//   - `stdin`: the message is written to the PTY, so the process reads it as
//     input. Correct for an AI agent CLI whose stdin *is* its prompt.

import { EventEmitter } from 'node:events';
import os from 'node:os';

import {
  DELIVERY_CHANNELS,
  DELIVERY_MODES,
  DELIVERY_MODE_VALUES,
  TRACE,
  clampInt,
  formatForPty,
  isLabel,
  stripAnsi,
} from '../shared/protocol.js';

const SCROLLBACK_BYTES = 256 * 1024;
const MAX_PANES = 32;

/** Default shell per platform. */
export function defaultShell() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

/**
 * Prepend a directory to PATH in-place. Windows env blocks spell the key
 * `Path`; reuse whatever spelling is already there instead of adding a twin.
 * @param {Record<string,string>} env
 * @param {string} dir
 */
export function prependPath(env, dir) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key] ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  env[key] = current ? `${dir}${sep}${current}` : dir;
  return env;
}

class Pane {
  /**
   * @param {object} init
   */
  constructor(init) {
    this.id = init.id;
    this.label = init.label;
    this.command = init.command;
    this.args = init.args;
    this.cwd = init.cwd;
    this.cols = init.cols;
    this.rows = init.rows;
    this.createdAt = init.createdAt;
    this.deliveryMode = init.deliveryMode;
    this.pty = init.pty;
    this.pid = init.pty?.pid ?? null;
    this.exit = null;
    /** @type {string[]} */
    this.chunks = [];
    this.bytes = 0;
  }

  append(data) {
    this.chunks.push(data);
    this.bytes += data.length;
    while (this.bytes > SCROLLBACK_BYTES && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift().length;
    }
  }

  scrollback() {
    return this.chunks.join('');
  }

  toJSON() {
    return {
      id: this.id,
      label: this.label,
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      pid: this.pid,
      createdAt: this.createdAt,
      deliveryMode: this.deliveryMode,
      alive: this.exit === null,
      exit: this.exit,
    };
  }
}

export class PaneManager extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('./tracer.js').Tracer} deps.tracer
   * @param {import('./bus.js').MessageBus} deps.bus
   * @param {typeof import('node-pty')} [deps.pty] Injectable for tests.
   * @param {string} [deps.cwd] Default working directory for new panes.
   */
  constructor({ tracer, bus, pty, cwd } = {}) {
    super();
    this.setMaxListeners(0);
    if (!tracer) throw new Error('PaneManager requires a tracer');
    if (!bus) throw new Error('PaneManager requires a bus');
    this.tracer = tracer;
    this.bus = bus;
    this.ptyLib = pty ?? null;
    this.defaultCwd = cwd || process.cwd();
    /** @type {Map<string, Pane>} */
    this.panes = new Map();
    this.counter = 0;
  }

  async #loadPty() {
    if (!this.ptyLib) {
      this.ptyLib = await import('node-pty');
    }
    return this.ptyLib;
  }

  list() {
    return [...this.panes.values()].map((pane) => pane.toJSON());
  }

  get(paneId) {
    return this.panes.get(paneId) ?? null;
  }

  aliveIds() {
    return [...this.panes.values()].filter((p) => p.exit === null).map((p) => p.id);
  }

  /**
   * Spawn a new CLI pane.
   *
   * @param {object} [spec]
   * @param {string} [spec.label] Human name shown on the pane header.
   * @param {string} [spec.command] Executable; defaults to the user's shell.
   * @param {string[]} [spec.args]
   * @param {string} [spec.cwd]
   * @param {number} [spec.cols]
   * @param {number} [spec.rows]
   * @param {Record<string,string>} [spec.env]
   * @param {'display'|'stdin'} [spec.deliveryMode] How hive messages arrive.
   *   `display` paints into the viewport (safe for a plain shell, default),
   *   `stdin` writes to the process (for agent CLIs that read stdin).
   */
  async create(spec = {}) {
    if (this.panes.size >= MAX_PANES) {
      throw new Error(`pane limit reached (${MAX_PANES})`);
    }

    const pty = await this.#loadPty();
    this.counter += 1;

    const id = isLabel(spec.id) ? String(spec.id).trim() : `p${this.counter}`;
    if (this.panes.has(id)) throw new Error(`pane id already in use: ${id}`);

    const label = isLabel(spec.label) ? spec.label.trim() : `cli-${this.counter}`;
    const command = isLabel(spec.command) ? spec.command.trim() : defaultShell();
    const args = Array.isArray(spec.args) ? spec.args.filter((a) => typeof a === 'string') : [];
    const cwd = isLabel(spec.cwd) ? spec.cwd : this.defaultCwd;
    const cols = clampInt(spec.cols, 20, 500, 100);
    const rows = clampInt(spec.rows, 5, 200, 28);
    const deliveryMode = DELIVERY_MODE_VALUES.includes(spec.deliveryMode)
      ? spec.deliveryMode
      : DELIVERY_MODES.DISPLAY;

    // Panes learn their own identity from the environment, so `hive send`
    // inside a pane needs no arguments to know who it is.
    const env = {
      ...process.env,
      ...(spec.env && typeof spec.env === 'object' ? spec.env : {}),
      CLIHIVE_PANE_ID: id,
      CLIHIVE_PANE_LABEL: label,
      CLIHIVE_DELIVERY_MODE: deliveryMode,
      TERM: 'xterm-256color',
    };
    if (isLabel(spec.pathPrepend)) prependPath(env, spec.pathPrepend);

    let child;
    try {
      child = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      });
    } catch (err) {
      this.tracer.emitTrace(TRACE.PANE_SPAWN, {
        paneId: id,
        label,
        command,
        ok: false,
        error: err?.message ?? String(err),
      });
      throw err;
    }

    const pane = new Pane({
      id,
      label,
      command,
      args,
      cwd,
      cols,
      rows,
      createdAt: Date.now(),
      deliveryMode,
      pty: child,
    });
    this.panes.set(id, pane);

    this.bus.registerPtySink(id, (msg) => this.#injectMessage(pane, msg));

    child.onData((data) => {
      pane.append(data);
      this.emit('data', { paneId: id, data });
    });

    child.onExit(({ exitCode, signal }) => {
      pane.exit = { code: exitCode ?? null, signal: signal ?? null, at: Date.now() };
      this.tracer.emitTrace(TRACE.PANE_EXIT, {
        paneId: id,
        label,
        exitCode: exitCode ?? null,
        signal: signal ?? null,
      });
      this.bus.unregisterPane(id);
      this.emit('exit', { paneId: id, exit: pane.exit });
    });

    this.tracer.emitTrace(TRACE.PANE_SPAWN, {
      paneId: id,
      label,
      command,
      args,
      cwd,
      cols,
      rows,
      pid: pane.pid,
      ok: true,
    });
    this.tracer.emitTrace(TRACE.PANE_READY, { paneId: id, label, pid: pane.pid });
    this.emit('panes', this.list());

    return pane.toJSON();
  }

  /**
   * Hand a bus message to a pane, honouring its delivery mode.
   * Returns `{ ok, channel }` so the bus can record the real channel used.
   */
  #injectMessage(pane, msg) {
    if (pane.exit !== null) return { ok: false, channel: null, reason: 'pane-exited' };

    if (pane.deliveryMode === DELIVERY_MODES.STDIN) {
      const block = formatForPty(msg, { label: pane.label, mode: DELIVERY_MODES.STDIN });
      try {
        pane.pty.write(block);
        return { ok: true, channel: DELIVERY_CHANNELS.PTY };
      } catch (err) {
        return { ok: false, channel: DELIVERY_CHANNELS.PTY, reason: `write-failed: ${err?.message ?? err}` };
      }
    }

    // Display mode: paint into the viewport. The child process never sees it,
    // so a plain shell will not try to run the text as a command. It goes into
    // the scrollback too, so a reconnecting window replays it in place.
    const block = formatForPty(msg, { label: pane.label, mode: DELIVERY_MODES.DISPLAY });
    pane.append(block);
    this.emit('data', { paneId: pane.id, data: block, overlay: true });
    return { ok: true, channel: DELIVERY_CHANNELS.DISPLAY };
  }

  /**
   * Forward keystrokes from the UI.
   * @param {string} paneId
   * @param {string} data
   */
  write(paneId, data) {
    const pane = this.panes.get(paneId);
    if (!pane || pane.exit !== null) return false;
    if (typeof data !== 'string' || data.length === 0) return false;
    pane.pty.write(data);
    // Trace only the shape of human input, never the raw keystrokes, but keep
    // whole submitted lines because those are the interesting ones.
    const clean = stripAnsi(data);
    if (clean.includes('\r') || clean.includes('\n')) {
      this.tracer.emitTrace(TRACE.PANE_INPUT, {
        paneId,
        chars: data.length,
        line: clean.replace(/[\r\n]+/g, ' ').trim().slice(0, 200),
      });
    }
    return true;
  }

  resize(paneId, cols, rows) {
    const pane = this.panes.get(paneId);
    if (!pane || pane.exit !== null) return false;
    const c = clampInt(cols, 20, 500, pane.cols);
    const r = clampInt(rows, 5, 200, pane.rows);
    if (c === pane.cols && r === pane.rows) return true;
    pane.cols = c;
    pane.rows = r;
    try {
      pane.pty.resize(c, r);
    } catch {
      return false;
    }
    this.tracer.emitTrace(TRACE.PANE_RESIZE, { paneId, cols: c, rows: r });
    return true;
  }

  kill(paneId) {
    const pane = this.panes.get(paneId);
    if (!pane) return false;
    this.tracer.emitTrace(TRACE.PANE_KILL, { paneId, label: pane.label });
    if (pane.exit === null) {
      try {
        pane.pty.kill();
      } catch {
        // Already gone.
      }
    }
    return true;
  }

  scrollback(paneId) {
    const pane = this.panes.get(paneId);
    return pane ? pane.scrollback() : '';
  }

  /** Kill everything. Used on shutdown. */
  killAll() {
    for (const id of [...this.panes.keys()]) this.kill(id);
  }

  /** Drop exited panes from the roster. */
  prune() {
    let removed = 0;
    for (const [id, pane] of this.panes) {
      if (pane.exit !== null) {
        this.panes.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) this.emit('panes', this.list());
    return removed;
  }

  info() {
    return {
      count: this.panes.size,
      alive: this.aliveIds().length,
      max: MAX_PANES,
      platform: `${os.platform()} ${os.release()}`,
      shell: defaultShell(),
    };
  }
}
