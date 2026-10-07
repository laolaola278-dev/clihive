// Resolve an installed agent CLI to something spawnable WITHOUT a shell.
//
// On Windows, npm creates `codex` (bash), `codex.cmd`, and `codex.ps1` shims.
// Spawning a `.cmd` without a shell fails on patched Node, and spawning with a
// shell re-opens quoting/injection problems the plan explicitly forbids. So we
// parse the shim to find the real entry: either a native `.exe` or the Node
// script the shim runs. Every path comes from an array argument list, never
// from string concatenation.
import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export class CliNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliNotFoundError';
  }
}

function defaultWhich(name, platform) {
  const probe = platform === 'win32'
    ? spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true })
    : spawnSync('which', [name], { encoding: 'utf8' });
  if (probe.status !== 0) return [];
  return probe.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// npm's .ps1 shim is the most regular one:
//   & "$basedir/node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args
//   & "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe"   $args
async function parsePs1Shim(shimPath, { readShim, findNode }) {
  const text = await readShim(shimPath);
  const basedir = path.dirname(shimPath);
  // A real npm shim references "$basedir/node$exe" (the interpreter) and then
  // "$basedir/node_modules/<pkg>/<entry>" (the target). The LAST reference on
  // the invocation lines is the thing actually launched.
  const matches = [...text.matchAll(/"\$basedir\/([^"]+?)"/g)].map((m) => m[1]);
  if (!matches.length) return null;
  const target = path.resolve(basedir, matches[matches.length - 1].replace(/\$exe\b/g, '.exe'));
  if (target.toLowerCase().endsWith('.js')) {
    // The shim runs the script with node: prefer a node.exe next to the shim,
    // then the node on PATH.
    const localNode = path.join(basedir, 'node.exe');
    const nodeCommand = await exists(localNode) ? localNode : await findNode();
    if (!nodeCommand) return null;
    return { command: nodeCommand, prependArgs: [target], resolvedFrom: shimPath };
  }
  return { command: target, prependArgs: [], resolvedFrom: shimPath };
}

// npm's .cmd shim ends with either a direct binary:
//   "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
// or a node script:
//   "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
async function parseCmdShim(shimPath, { readShim, findNode }) {
  const text = await readShim(shimPath);
  const basedir = path.dirname(shimPath);
  // A shim may also reference "%dp0%\node.exe" (the interpreter probe). The
  // launched target is the node_modules entry; fall back to the last non-node
  // reference for shims that point somewhere else.
  const matches = [...text.matchAll(/"%dp0%[\\/]([^"]+?\.(?:js|exe))"/gi)].map((m) => m[1]);
  const relative = matches.find((m) => /node_modules/i.test(m))
    ?? matches.filter((m) => !/^node\.exe$/i.test(m)).pop();
  if (!relative) return null;
  const target = path.resolve(basedir, relative);
  if (target.toLowerCase().endsWith('.exe')) {
    return { command: target, prependArgs: [], resolvedFrom: shimPath };
  }
  const nodeCommand = await findNode();
  if (!nodeCommand) return null;
  return { command: nodeCommand, prependArgs: [target], resolvedFrom: shimPath };
}

/**
 * @param {string} name CLI base name, e.g. "codex".
 * @param {object} [options] Injection points for tests.
 * @returns {Promise<{command:string, prependArgs:string[], resolvedFrom:string}>}
 */
export async function resolveCliExecutable(name, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const which = options.which ?? defaultWhich;
  const readShim = options.readShim ?? ((file) => readFile(file, 'utf8'));

  // Operator-side override (documented env var). Still must be an existing
  // file; we never accept executable paths from untrusted request payloads.
  const override = env[`CLIHIVE_${name.toUpperCase()}_BIN`];
  if (override) {
    if (!await exists(override)) throw new CliNotFoundError(`${name}: CLIHIVE_${name.toUpperCase()}_BIN points at a missing file`);
    return { command: override, prependArgs: [], resolvedFrom: `env:CLIHIVE_${name.toUpperCase()}_BIN` };
  }

  const candidates = which(name, platform);
  if (!candidates.length) throw new CliNotFoundError(`${name} was not found on PATH`);
  const findNode = async () => which('node', platform)[0] ?? null;

  if (platform === 'win32') {
    const exe = candidates.find((c) => c.toLowerCase().endsWith('.exe'));
    if (exe) return { command: exe, prependArgs: [], resolvedFrom: exe };
    const ps1 = candidates.find((c) => c.toLowerCase().endsWith('.ps1'));
    if (ps1) {
      const parsed = await parsePs1Shim(ps1, { readShim, findNode });
      if (parsed) return parsed;
    }
    const cmd = candidates.find((c) => c.toLowerCase().endsWith('.cmd'));
    if (cmd) {
      const parsed = await parseCmdShim(cmd, { readShim, findNode });
      if (parsed) return parsed;
    }
    throw new CliNotFoundError(`${name}: found ${candidates.join(', ')} but none can be spawned safely without a shell; set CLIHIVE_${name.toUpperCase()}_BIN`);
  }

  // POSIX: the shim is an executable script with a shebang; spawn it directly.
  return { command: candidates[0], prependArgs: [], resolvedFrom: candidates[0] };
}
