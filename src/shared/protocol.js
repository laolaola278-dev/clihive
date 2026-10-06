// Wire protocol and shared vocabulary for clihive.
//
// One window holds many small CLI panes. Every pane can talk. A hideable
// orchestrator pane on the right talks to all of them and coordinates them.
// Every message is recorded on a shared transcript and every delivery step is
// traced, so you can watch whether a pane actually received a message.

import { randomUUID } from 'node:crypto';

export const PROTOCOL_VERSION = 1;

/** Default loopback port for the hive server. */
export const DEFAULT_PORT = 7420;

/** Reserved address: every pane except the sender. */
export const ADDRESS_ALL = 'all';

/** Reserved address: the orchestrator pane on the right. */
export const ADDRESS_ORCHESTRATOR = 'orchestrator';

/** Reserved address: the human sitting in front of the window. */
export const ADDRESS_HUMAN = 'human';

export const RESERVED_ADDRESSES = Object.freeze([
  ADDRESS_ALL,
  ADDRESS_ORCHESTRATOR,
  ADDRESS_HUMAN,
]);

/** What a message is for. Kept small on purpose. */
export const MESSAGE_KINDS = Object.freeze({
  CHAT: 'chat',
  TASK: 'task',
  RESULT: 'result',
  SYSTEM: 'system',
});

const MESSAGE_KIND_VALUES = Object.freeze(Object.values(MESSAGE_KINDS));

/** How a message physically reached a pane. */
export const DELIVERY_CHANNELS = Object.freeze({
  /**
   * Painted into the pane's viewport without touching the child process.
   * Safe for any pane, including a plain shell: the pane *sees* the message,
   * the shell never tries to execute it. This is the default.
   */
  DISPLAY: 'display',
  /**
   * Written to the pane's stdin, so the process reads it as input. Correct for
   * panes running an AI agent CLI that treats stdin as its prompt; destructive
   * for a plain shell, which would try to run the text. Opt-in per pane.
   */
  PTY: 'pty',
  /** Pulled by the pane itself through `hive inbox`. */
  CLI: 'cli',
  /** Rendered into the orchestrator panel. */
  PANEL: 'panel',
});

/** Per-pane delivery mode, chosen at spawn time. */
export const DELIVERY_MODES = Object.freeze({
  DISPLAY: 'display',
  STDIN: 'stdin',
});

export const DELIVERY_MODE_VALUES = Object.freeze(Object.values(DELIVERY_MODES));

/**
 * Trace event kinds. This is the observability contract: the trace view and the
 * JSONL file both speak exactly these names.
 */
export const TRACE = Object.freeze({
  HIVE_START: 'hive.start',
  HIVE_STOP: 'hive.stop',

  PANE_SPAWN: 'pane.spawn',
  PANE_READY: 'pane.ready',
  PANE_EXIT: 'pane.exit',
  PANE_KILL: 'pane.kill',
  PANE_RESIZE: 'pane.resize',
  PANE_INPUT: 'pane.input',

  MSG_SEND: 'msg.send',
  MSG_FANOUT: 'msg.fanout',
  MSG_DELIVER: 'msg.deliver',
  MSG_ACK: 'msg.ack',
  MSG_DROP: 'msg.drop',

  ORCH_PROMPT: 'orch.prompt',
  ORCH_REPLY: 'orch.reply',
  ORCH_ACTION: 'orch.action',
  ORCH_ERROR: 'orch.error',

  CLIENT_ATTACH: 'client.attach',
  CLIENT_DETACH: 'client.detach',
});

/** Server -> client websocket frame types. */
export const WS_SERVER = Object.freeze({
  HELLO: 'hello',
  PANE_LIST: 'pane.list',
  PANE_DATA: 'pane.data',
  PANE_EXIT: 'pane.exit',
  /** A pane is holding injected text back because a full-screen app owns it. */
  PANE_HELD: 'pane.held',
  MESSAGE: 'message',
  DELIVERY: 'delivery',
  TRACE: 'trace',
  ORCH_REPLY: 'orch.reply',
  ERROR: 'error',
});

/** Client -> server websocket frame types. */
export const WS_CLIENT = Object.freeze({
  PANE_CREATE: 'pane.create',
  PANE_INPUT: 'pane.input',
  PANE_RESIZE: 'pane.resize',
  PANE_KILL: 'pane.kill',
  PANE_SUBSCRIBE: 'pane.subscribe',
  SEND: 'message.send',
  ORCH_ASK: 'orch.ask',
  PING: 'ping',
});

let counter = 0;

/**
 * Short, sortable, collision-resistant id.
 * @param {string} prefix
 * @returns {string}
 */
export function makeId(prefix = 'id') {
  counter = (counter + 1) % 0xffff;
  const time = Date.now().toString(36);
  const seq = counter.toString(36).padStart(3, '0');
  const rand = randomUUID().slice(0, 4);
  return `${prefix}_${time}${seq}${rand}`;
}

/**
 * True when `value` is a usable, non-empty single-line label.
 * @param {unknown} value
 */
export function isLabel(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value);
}

/**
 * Validate a pane-facing address. Reserved names are always allowed; anything
 * else must look like a pane id.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAddress(value) {
  if (!isLabel(value)) return false;
  const trimmed = value.trim();
  if (RESERVED_ADDRESSES.includes(trimmed)) return true;
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(trimmed);
}

export class ProtocolError extends Error {
  constructor(message, { field } = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.field = field ?? null;
  }
}

/**
 * Normalize an untrusted message payload into the canonical shape the bus
 * stores. Throws {@link ProtocolError} on bad input so callers can answer 400.
 *
 * @param {Record<string, unknown>} input
 * @returns {{
 *   id: string, ts: number, from: string, to: string, kind: string,
 *   text: string, meta: Record<string, unknown>
 * }}
 */
export function normalizeMessage(input) {
  if (!input || typeof input !== 'object') {
    throw new ProtocolError('message must be an object');
  }

  const from = typeof input.from === 'string' ? input.from.trim() : '';
  if (!isAddress(from)) {
    throw new ProtocolError('"from" must be a pane id or a reserved address', { field: 'from' });
  }

  const to = typeof input.to === 'string' && input.to.trim() ? input.to.trim() : ADDRESS_ALL;
  if (!isAddress(to)) {
    throw new ProtocolError('"to" must be a pane id or a reserved address', { field: 'to' });
  }

  const kind = typeof input.kind === 'string' && input.kind.trim()
    ? input.kind.trim()
    : MESSAGE_KINDS.CHAT;
  if (!MESSAGE_KIND_VALUES.includes(kind)) {
    throw new ProtocolError(`"kind" must be one of ${MESSAGE_KIND_VALUES.join(', ')}`, { field: 'kind' });
  }

  const text = typeof input.text === 'string' ? input.text : '';
  if (!text.trim()) {
    throw new ProtocolError('"text" must not be empty', { field: 'text' });
  }
  if (text.length > 64_000) {
    throw new ProtocolError('"text" must be at most 64000 characters', { field: 'text' });
  }

  let meta = {};
  if (input.meta != null) {
    if (typeof input.meta !== 'object' || Array.isArray(input.meta)) {
      throw new ProtocolError('"meta" must be an object', { field: 'meta' });
    }
    meta = { ...input.meta };
  }

  return {
    id: isLabel(input.id) ? String(input.id).trim() : makeId('msg'),
    ts: Number.isFinite(input.ts) ? Number(input.ts) : Date.now(),
    from,
    to,
    kind,
    text,
    meta,
  };
}

/**
 * Should `paneId` see `msg` on the shared transcript?
 *
 * Every pane sees every pane-to-pane message in the window -- that shared view
 * is the point of the hive. Direct messages to the orchestrator or to the human
 * stay private unless the pane is a participant.
 *
 * @param {{from: string, to: string}} msg
 * @param {string} paneId
 */
export function isVisibleTo(msg, paneId) {
  if (!msg || !paneId) return false;
  if (msg.from === paneId || msg.to === paneId) return true;
  if (msg.to === ADDRESS_ALL) return true;
  // A pane's report to the orchestrator is visible to the whole hive so panes
  // can follow what their peers are doing; the reverse (orchestrator -> one
  // pane) is a private instruction.
  if (msg.to === ADDRESS_ORCHESTRATOR) return true;
  return false;
}

/**
 * Who should actually receive `msg`, given the known pane ids.
 * @param {{from: string, to: string}} msg
 * @param {Iterable<string>} paneIds
 * @returns {string[]}
 */
export function resolveTargets(msg, paneIds) {
  const ids = [...paneIds];
  if (msg.to === ADDRESS_ALL) {
    return ids.filter((id) => id !== msg.from);
  }
  if (msg.to === ADDRESS_ORCHESTRATOR || msg.to === ADDRESS_HUMAN) {
    return [msg.to];
  }
  return ids.includes(msg.to) ? [msg.to] : [];
}

/**
 * Render a message as the block a pane receives.
 *
 * Deliberately boring and greppable so an agent can be told to look for it.
 * `mode: 'display'` wraps it in a dim frame and uses CRLF, because it is
 * painted straight into the terminal viewport rather than typed into a shell.
 *
 * @param {{id: string, from: string, to: string, kind: string, text: string}} msg
 * @param {{ label?: string, mode?: string }} [opts]
 */
export function formatForPty(msg, opts = {}) {
  const label = opts.label ? ` ${opts.label}` : '';
  const scope = msg.to === ADDRESS_ALL ? 'all' : msg.to;
  const head = `[hive${label}] ${msg.kind} from ${msg.from} to ${scope} (${msg.id})`;
  const body = msg.text.replace(/\r\n/g, '\n').trimEnd();

  if (opts.mode === DELIVERY_MODES.DISPLAY) {
    // Paint into the viewport: dim header, plain body, always on fresh lines.
    const lines = body.split('\n');
    return `\r\n\u001b[2m${head}\u001b[0m\r\n${lines.join('\r\n')}\r\n`;
  }
  return `${head}\n${body}\n`;
}

/** Strip ANSI escape sequences so trace/log output stays readable. */
export function stripAnsi(input) {
  if (typeof input !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u001B\][^\u0007]*\u0007/g, '');
}

/** Clamp a number into a range, falling back when it is not finite. */
export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
