// Probe: what does a stdin-mode pane actually show?
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { HiveServer } from '../src/server/http.js';
import { stripAnsi } from '../src/shared/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = await mkdtemp(path.join(os.tmpdir(), 'clihive-dbg2-'));
process.env.CLIHIVE_HOME = home;

const server = new HiveServer({ rootDir: root, port: 0, tracePath: null });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await server.listen();

const c = await server.createPane({ label: 'agentish', deliveryMode: 'stdin' });
await sleep(1500);
console.log('pane:', JSON.stringify({ id: c.id, mode: c.deliveryMode }));

const res = await server.bus.publish(
  { from: 'p99', to: 'all', kind: 'chat', text: 'MARKER-STDIN-77' },
  { origin: 'test', paneIds: [...server.panes.aliveIds(), 'p99'] },
);
console.log('deliveries:', JSON.stringify(res.deliveries));
await sleep(2000);

const raw = server.panes.scrollback(c.id);
console.log('raw:', JSON.stringify(raw.slice(-500)));
console.log('flat has marker:', stripAnsi(raw).replace(/\s+/g, ' ').includes('MARKER-STDIN-77'));

await server.close();
await sleep(300);
await rm(home, { recursive: true, force: true }).catch(() => {});
process.exit(0);
