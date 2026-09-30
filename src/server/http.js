// HTTP + WebSocket server.
//
// Two audiences share one origin:
//   - the window (WebSocket): pane output, transcript, trace stream.
//   - the panes themselves (HTTP/JSON): the `hive` CLI posts and polls here.
//
// Binds to loopback only. A token generated at startup is written to
// ~/.clihive/token and handed to panes through the environment, so a pane can
// talk to the bus without the human wiring anything up.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { WebSocketServer } from 'ws';

import {
  ADDRESS_HUMAN,
  ADDRESS_ORCHESTRATOR,
  DEFAULT_PORT,
  TRACE,
  WS_CLIENT,
  WS_SERVER,
  ProtocolError,
  clampInt,
} from '../shared/protocol.js';
import { Tracer } from './tracer.js';
import { MessageBus } from './bus.js';
import { PaneManager } from './panes.js';
import { Orchestrator } from './orchestrator.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

export function hiveHome() {
  return process.env.CLIHIVE_HOME || path.join(os.homedir(), '.clihive');
}

/** Resolve the static roots: the app UI and the vendored xterm files. */
function staticRoots(rootDir) {
  return [
    { prefix: '/', dir: path.join(rootDir, 'src', 'ui') },
    { prefix: '/vendor/xterm/', dir: path.join(rootDir, 'node_modules', '@xterm', 'xterm') },
    { prefix: '/vendor/addon-fit/', dir: path.join(rootDir, 'node_modules', '@xterm', 'addon-fit') },
  ];
}

export class HiveServer {
  /**
   * @param {object} [options]
   * @param {number} [options.port]
   * @param {string} [options.host]
   * @param {string} [options.rootDir] Repo root, for serving static assets.
   * @param {string} [options.cwd] Default pane working directory.
   * @param {string|null} [options.tracePath] JSONL trace file.
   * @param {boolean} [options.writeToken] Persist the token to disk.
   */
  constructor(options = {}) {
    // 0 is allowed on purpose: it asks the OS for a free port (tests use it).
    this.port = clampInt(options.port ?? process.env.CLIHIVE_PORT ?? DEFAULT_PORT, 0, 65535, DEFAULT_PORT);
    this.host = options.host ?? '127.0.0.1';
    this.rootDir = options.rootDir ?? process.cwd();
    this.cwd = options.cwd ?? process.cwd();
    this.token = options.token ?? randomBytes(24).toString('hex');
    this.writeToken = options.writeToken !== false;
    this.startedAt = Date.now();

    const tracePath = options.tracePath === undefined
      ? path.join(hiveHome(), 'trace.jsonl')
      : options.tracePath;

    this.tracer = new Tracer({ file: tracePath });
    this.bus = new MessageBus({ tracer: this.tracer });
    this.panes = new PaneManager({ tracer: this.tracer, bus: this.bus, cwd: this.cwd });
    this.orchestrator = new Orchestrator({
      bus: this.bus,
      panes: this.panes,
      tracer: this.tracer,
      model: options.model,
    });

    /** @type {Set<import('ws').WebSocket>} */
    this.clients = new Set();
    this.http = createServer((req, res) => {
      this.#handleHttp(req, res).catch((err) => {
        this.#json(res, 500, { error: err?.message ?? String(err) });
      });
    });
    this.wss = new WebSocketServer({ noServer: true });

    this.#wireEvents();
    this.#wireUpgrade();
  }

  get url() {
    return `http://${this.host}:${this.port}`;
  }

  /** Environment a pane needs to reach this hive. */
  paneEnv() {
    return {
      CLIHIVE_URL: this.url,
      CLIHIVE_TOKEN: this.token,
    };
  }

  /** Spec fragment every new pane gets: hive env + `hive` on PATH. */
  paneDefaults() {
    return { env: this.paneEnv(), pathPrepend: path.join(this.rootDir, 'bin') };
  }

  /** Create a pane from an untrusted spec, forcing hive-owned fields. */
  async createPane(spec = {}) {
    const safe = spec && typeof spec === 'object' ? spec : {};
    const { env: _ignoredEnv, pathPrepend: _ignoredPath, ...rest } = safe;
    return this.panes.create({ ...rest, ...this.paneDefaults() });
  }

  #wireEvents() {
    this.panes.on('data', ({ paneId, data }) => {
      this.#broadcast({ type: WS_SERVER.PANE_DATA, paneId, data });
    });
    this.panes.on('exit', ({ paneId, exit }) => {
      this.#broadcast({ type: WS_SERVER.PANE_EXIT, paneId, exit });
      this.#broadcast({ type: WS_SERVER.PANE_LIST, panes: this.panes.list() });
    });
    this.panes.on('panes', (panes) => {
      this.#broadcast({ type: WS_SERVER.PANE_LIST, panes });
    });
    this.bus.on('message', (message) => {
      this.#broadcast({ type: WS_SERVER.MESSAGE, message });
    });
    this.bus.on('delivery', (delivery) => {
      this.#broadcast({ type: WS_SERVER.DELIVERY, delivery });
    });
    this.tracer.on('trace', (event) => {
      this.#broadcast({ type: WS_SERVER.TRACE, event });
    });
    this.orchestrator.on('entry', (entry) => {
      this.#broadcast({ type: WS_SERVER.ORCH_REPLY, entry });
    });
  }

  #wireUpgrade() {
    this.http.on('upgrade', (req, socket, head) => {
      let url;
      try {
        url = new URL(req.url, this.url);
      } catch {
        socket.destroy();
        return;
      }
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      if (url.searchParams.get('token') !== this.token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.#onClient(ws);
      });
    });
  }

  #onClient(ws) {
    this.clients.add(ws);
    this.tracer.emitTrace(TRACE.CLIENT_ATTACH, { clients: this.clients.size });

    ws.send(JSON.stringify({
      type: WS_SERVER.HELLO,
      token: this.token,
      panes: this.panes.list(),
      transcript: this.bus.fullTranscript(200),
      trace: this.tracer.recent(300),
      orchestrator: this.orchestrator.recent(100),
      status: this.status(),
    }));

    ws.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: WS_SERVER.ERROR, error: 'invalid JSON frame' }));
        return;
      }
      this.#handleFrame(ws, frame).catch((err) => {
        ws.send(JSON.stringify({
          type: WS_SERVER.ERROR,
          error: err?.message ?? String(err),
          frame: frame?.type ?? null,
        }));
      });
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      this.tracer.emitTrace(TRACE.CLIENT_DETACH, { clients: this.clients.size });
    });
    ws.on('error', () => {
      this.clients.delete(ws);
    });
  }

  async #handleFrame(ws, frame) {
    switch (frame?.type) {
      case WS_CLIENT.PANE_CREATE: {
        const pane = await this.createPane(frame.spec);
        ws.send(JSON.stringify({ type: 'pane.created', pane }));
        break;
      }
      case WS_CLIENT.PANE_INPUT:
        this.panes.write(frame.paneId, frame.data);
        break;
      case WS_CLIENT.PANE_RESIZE:
        this.panes.resize(frame.paneId, frame.cols, frame.rows);
        break;
      case WS_CLIENT.PANE_KILL:
        this.panes.kill(frame.paneId);
        break;
      case WS_CLIENT.PANE_SUBSCRIBE:
        ws.send(JSON.stringify({
          type: WS_SERVER.PANE_DATA,
          paneId: frame.paneId,
          data: this.panes.scrollback(frame.paneId),
          replay: true,
        }));
        break;
      case WS_CLIENT.SEND: {
        const result = await this.bus.publish(
          { ...frame.message, from: frame.message?.from || ADDRESS_HUMAN },
          { origin: 'ws', paneIds: this.panes.aliveIds() },
        );
        ws.send(JSON.stringify({ type: 'message.sent', ...result }));
        break;
      }
      case WS_CLIENT.ORCH_ASK: {
        const reply = await this.orchestrator.ask({ text: frame.text, to: frame.to });
        ws.send(JSON.stringify({ type: 'orch.result', ...reply }));
        break;
      }
      case WS_CLIENT.PING:
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        break;
      default:
        ws.send(JSON.stringify({ type: WS_SERVER.ERROR, error: `unknown frame: ${frame?.type}` }));
    }
  }

  #broadcast(payload) {
    if (this.clients.size === 0) return;
    const data = JSON.stringify(payload);
    for (const ws of this.clients) {
      if (ws.readyState === 1) {
        try {
          ws.send(data);
        } catch {
          this.clients.delete(ws);
        }
      }
    }
  }

  #json(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(data),
      'cache-control': 'no-store',
    });
    res.end(data);
  }

  async #readBody(req, limit = 256 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new Error('request body too large');
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return {};
    return JSON.parse(text);
  }

  #authorized(req, url) {
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const supplied = bearer || url.searchParams.get('token') || req.headers['x-clihive-token'] || '';
    return supplied === this.token;
  }

  status() {
    return {
      url: this.url,
      uptimeMs: Date.now() - this.startedAt,
      panes: this.panes.info(),
      orchestrator: this.orchestrator.status(),
      clients: this.clients.size,
      tracePath: this.tracer.file,
      traceEvents: this.tracer.seq,
    };
  }

  async #handleHttp(req, res) {
    const url = new URL(req.url, this.url);

    if (url.pathname.startsWith('/api/')) {
      if (!this.#authorized(req, url)) {
        this.#json(res, 401, { error: 'bad or missing token' });
        return;
      }
      await this.#handleApi(req, res, url);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      this.#json(res, 405, { error: 'method not allowed' });
      return;
    }
    await this.#serveStatic(req, res, url);
  }

  async #handleApi(req, res, url) {
    const route = url.pathname.slice('/api/'.length);
    const method = req.method ?? 'GET';

    try {
      // --- pane-facing endpoints, used by the `hive` CLI ------------------
      if (route === 'send' && method === 'POST') {
        const body = await this.#readBody(req);
        const from = body.from || process.env.CLIHIVE_PANE_ID || ADDRESS_HUMAN;
        const result = await this.bus.publish(
          { ...body, from },
          { origin: 'cli', paneIds: this.panes.aliveIds() },
        );
        this.#json(res, 200, {
          messageId: result.message.id,
          targets: result.deliveries.map((d) => ({
            target: d.target,
            ok: d.ok,
            channel: d.channel,
            reason: d.reason,
          })),
        });
        return;
      }

      if (route === 'inbox' && (method === 'GET' || method === 'POST')) {
        const paneId = url.searchParams.get('pane');
        if (!paneId) {
          this.#json(res, 400, { error: 'pane query parameter required' });
          return;
        }
        const peek = url.searchParams.get('peek') === '1';
        const messages = this.bus.drainInbox(paneId, { peek });
        this.#json(res, 200, { pane: paneId, count: messages.length, messages });
        return;
      }

      if (route === 'transcript' && method === 'GET') {
        const paneId = url.searchParams.get('pane');
        const limit = clampInt(url.searchParams.get('limit'), 1, 500, 50);
        const messages = paneId
          ? this.bus.transcriptFor(paneId, limit)
          : this.bus.fullTranscript(limit);
        this.#json(res, 200, { pane: paneId ?? null, count: messages.length, messages });
        return;
      }

      // --- window / operator endpoints -----------------------------------
      if (route === 'panes' && method === 'GET') {
        this.#json(res, 200, { panes: this.panes.list() });
        return;
      }

      if (route === 'panes' && method === 'POST') {
        const body = await this.#readBody(req);
        const pane = await this.createPane(body);
        this.#json(res, 201, { pane });
        return;
      }

      if (route.startsWith('panes/') && method === 'DELETE') {
        const paneId = decodeURIComponent(route.slice('panes/'.length));
        const ok = this.panes.kill(paneId);
        this.#json(res, ok ? 200 : 404, { paneId, killed: ok });
        return;
      }

      if (route === 'trace' && method === 'GET') {
        const limit = clampInt(url.searchParams.get('limit'), 1, 2000, 200);
        const prefix = url.searchParams.get('prefix');
        const messageId = url.searchParams.get('message');
        let events;
        if (messageId) events = this.tracer.forMessage(messageId);
        else if (prefix) events = this.tracer.byPrefix(prefix, limit);
        else events = this.tracer.recent(limit);
        this.#json(res, 200, { count: events.length, events });
        return;
      }

      if (route === 'delivery' && method === 'GET') {
        const messageId = url.searchParams.get('message');
        if (!messageId) {
          this.#json(res, 400, { error: 'message query parameter required' });
          return;
        }
        this.#json(res, 200, this.bus.deliveryReport(messageId));
        return;
      }

      if (route === 'orchestrator' && method === 'GET') {
        this.#json(res, 200, {
          status: this.orchestrator.status(),
          entries: this.orchestrator.recent(clampInt(url.searchParams.get('limit'), 1, 500, 100)),
        });
        return;
      }

      if (route === 'orchestrator/ask' && method === 'POST') {
        const body = await this.#readBody(req);
        const reply = await this.orchestrator.ask({ text: body.text, to: body.to });
        this.#json(res, 200, reply);
        return;
      }

      if (route === 'status' && method === 'GET') {
        this.#json(res, 200, this.status());
        return;
      }

      this.#json(res, 404, { error: `unknown route: ${route}` });
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.#json(res, 400, { error: err.message, field: err.field });
        return;
      }
      if (err instanceof SyntaxError) {
        this.#json(res, 400, { error: `invalid JSON body: ${err.message}` });
        return;
      }
      throw err;
    }
  }

  async #serveStatic(req, res, url) {
    const roots = staticRoots(this.rootDir);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';

    for (const root of roots) {
      if (!rel.startsWith(root.prefix)) continue;
      const tail = rel.slice(root.prefix.length) || 'index.html';
      const target = path.resolve(root.dir, tail);
      // Path traversal guard: the resolved file must stay inside its root.
      if (target !== root.dir && !target.startsWith(root.dir + path.sep)) continue;
      if (!existsSync(target)) continue;

      try {
        const data = await readFile(target);
        res.writeHead(200, {
          'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
          'content-length': data.length,
          'cache-control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : data);
        return;
      } catch {
        // Fall through to the next root.
      }
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }

  /** Start listening. Resolves with `{ url, token }`. */
  async listen() {
    await new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.port, this.host, () => {
        this.http.removeListener('error', reject);
        resolve();
      });
    });

    const address = this.http.address();
    if (address && typeof address === 'object') this.port = address.port;

    if (this.writeToken) {
      const dir = hiveHome();
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'token'),
        JSON.stringify({ url: this.url, token: this.token, pid: process.pid }, null, 2),
        { encoding: 'utf8', mode: 0o600 },
      );
    }

    this.tracer.emitTrace(TRACE.HIVE_START, {
      url: this.url,
      pid: process.pid,
      mode: this.orchestrator.mode,
      tracePath: this.tracer.file,
    });

    return { url: this.url, token: this.token };
  }

  /** Stop everything: panes, sockets, listener, trace flush. */
  async close() {
    this.tracer.emitTrace(TRACE.HIVE_STOP, { uptimeMs: Date.now() - this.startedAt });
    this.panes.killAll();
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        // Ignore.
      }
    }
    this.clients.clear();
    await new Promise((resolve) => this.wss.close(resolve));
    await new Promise((resolve) => this.http.close(resolve));
    await this.tracer.drain();
  }
}

/** Read the token file a running hive wrote, for the CLI. */
export async function readTokenFile() {
  const file = path.join(hiveHome(), 'token');
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === 'string' && typeof parsed.url === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export { ADDRESS_ORCHESTRATOR };
