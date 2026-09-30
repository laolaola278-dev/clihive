// Debug probe: why does an injected message not show up in a pane?
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { HiveServer } from '../src/server/http.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = await mkdtemp(path.join(os.tmpdir(), 'clihive-dbg-'));
process.env.CLIHIVE_HOME = home;

const server = new HiveServer({ rootDir: root, port: 0, tracePath: null });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await server.listen();
const b = await server.createPane({ label: 'beta' });
await sleep(1500);

console.log('--- baseline scrollback ---');
console.log(JSON.stringify(server.panes.scrollback(b.id)));

const res = await server.bus.publish(
  { from: 'p99', to: 'all', kind: 'chat', text: 'MARKER-XYZ hello' },
  { origin: 'test', paneIds: [...server.panes.aliveIds(), 'p99'] },
);
console.log('--- deliveries ---');
console.log(JSON.stringify(res.deliveries, null, 2));

await sleep(1500);
console.log('--- scrollback after inject ---');
console.log(JSON.stringify(server.panes.scrollback(b.id)));
console.log('contains marker:', server.panes.scrollback(b.id).includes('MARKER-XYZ'));

// Compare: a plain write with CR submission.
server.panes.write(b.id, 'echo PLAIN-WRITE-OK\r');
await sleep(1200);
const sb = server.panes.scrollback(b.id);
console.log('contains PLAIN-WRITE-OK:', sb.includes('PLAIN-WRITE-OK'));
console.log('--- tail ---');
console.log(JSON.stringify(sb.slice(-600)));

await server.close();
await sleep(300);
await rm(home, { recursive: true, force: true }).catch(() => {});
process.exit(0);
