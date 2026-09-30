#!/usr/bin/env node
// Entry point: start the hive server, print where the window lives.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HiveServer } from './http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..', '..');

function parseArgs(argv) {
  const out = { panes: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') out.port = Number(argv[++i]);
    else if (arg === '--cwd') out.cwd = argv[++i];
    else if (arg === '--panes' || arg === '-n') out.panes = Number(argv[++i]);
    else if (arg === '--no-trace-file') out.tracePath = null;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

const HELP = `clihive server

Usage: node src/server/index.js [options]

  -p, --port <n>       Listen port (default 7420, env CLIHIVE_PORT)
      --cwd <dir>      Default working directory for new panes
  -n, --panes <n>      Pre-spawn n shell panes at startup
      --no-trace-file  Keep the trace in memory only
  -h, --help           Show this help

Environment:
  CLIHIVE_PORT         Listen port
  CLIHIVE_HOME         State directory (default ~/.clihive)
  CLIHIVE_BASE_URL     OpenAI-compatible base URL for the orchestrator
  CLIHIVE_API_KEY      API key; without it the orchestrator stays in manual mode
  CLIHIVE_MODEL        Model name
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const server = new HiveServer({
  rootDir,
  port: args.port,
  cwd: args.cwd,
  ...(args.tracePath === null ? { tracePath: null } : {}),
});

const { url, token } = await server.listen();

for (let i = 0; i < Math.min(8, Math.max(0, args.panes | 0)); i += 1) {
  try {
    await server.createPane({});
  } catch (err) {
    process.stderr.write(`failed to spawn pane: ${err?.message ?? err}\n`);
  }
}

const status = server.status();
process.stdout.write(
  [
    'clihive is up',
    `  window       ${url}/?token=${token}`,
    `  orchestrator ${status.orchestrator.mode}${status.orchestrator.model ? ` (${status.orchestrator.model})` : ''}`,
    `  trace        ${status.tracePath ?? 'memory only'}`,
    `  panes        ${status.panes.alive}/${status.panes.max}`,
    '',
    'Inside a pane, talk to the hive with:',
    '  hive send --to all "text"     broadcast to every other pane',
    '  hive inbox                    read and acknowledge waiting messages',
    '  hive read                     show the shared transcript',
    '',
  ].join('\n'),
);

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  process.stdout.write(`\nshutting down (${signal})...\n`);
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
