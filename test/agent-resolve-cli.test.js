import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveCliExecutable, CliNotFoundError } from '../src/server/agent-runtime/resolve-cli.js';

const SHIM_DIR = 'C:\\Users\\tester\\AppData\\Roaming\\npm';

const PS1_NODE_SHIM = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition - Parent
$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  $exe=".exe"
}
& "$basedir/node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args
exit $ret
`;

const PS1_EXE_SHIM = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition - Parent
& "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe"   $args
exit $LASTEXITCODE
`;

const CMD_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\tool\\bin\\tool.js" %*
`;

const CMD_EXE_SHIM = `@ECHO off
GOTO start
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*
`;

function winResolver(files, nodePath = 'C:\\Program Files\\nodejs\\node.exe') {
  return {
    platform: 'win32',
    env: {},
    which: (name) => (name === 'node' ? [nodePath] : (files[name] ?? [])),
    readShim: async (file) => {
      if (file.endsWith('codex.ps1')) return PS1_NODE_SHIM;
      if (file.endsWith('claude.ps1')) return PS1_EXE_SHIM;
      if (file.endsWith('claude.cmd')) return CMD_EXE_SHIM;
      return CMD_SHIM;
    },
  };
}

describe('resolveCliExecutable (win32)', () => {
  it('prefers a native exe candidate', async () => {
    const resolved = await resolveCliExecutable('claude', winResolver({
      claude: [`${SHIM_DIR}\\claude`, `${SHIM_DIR}\\claude.cmd`, `${SHIM_DIR}\\claude.exe`],
    }));
    assert.equal(resolved.command, `${SHIM_DIR}\\claude.exe`);
    assert.deepEqual(resolved.prependArgs, []);
  });

  it('parses a ps1 node shim into node + entry script', async () => {
    const resolved = await resolveCliExecutable('codex', winResolver({
      codex: [`${SHIM_DIR}\\codex`, `${SHIM_DIR}\\codex.cmd`, `${SHIM_DIR}\\codex.ps1`],
    }));
    assert.equal(resolved.command, 'C:\\Program Files\\nodejs\\node.exe');
    assert.deepEqual(resolved.prependArgs, [path.join(SHIM_DIR, 'node_modules/@openai/codex/bin/codex.js')]);
  });

  it('parses a ps1 exe shim into the direct binary', async () => {
    const resolved = await resolveCliExecutable('claude', winResolver({
      claude: [`${SHIM_DIR}\\claude`, `${SHIM_DIR}\\claude.ps1`],
    }));
    assert.equal(resolved.command, path.join(SHIM_DIR, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
    assert.deepEqual(resolved.prependArgs, []);
  });

  it('falls back to the cmd shim when no ps1 exists', async () => {
    const resolved = await resolveCliExecutable('tool', winResolver({
      tool: [`${SHIM_DIR}\\tool`, `${SHIM_DIR}\\tool.cmd`],
    }));
    assert.equal(resolved.command, 'C:\\Program Files\\nodejs\\node.exe');
    assert.equal(resolved.prependArgs.length, 1);
    assert.match(resolved.prependArgs[0], /node_modules[\\/]tool[\\/]bin[\\/]tool\.js$/);
  });

  it('resolves a cmd shim that launches a native exe, ignoring node.exe probes', async () => {
    const resolved = await resolveCliExecutable('claude', winResolver({
      claude: [`${SHIM_DIR}\\claude`, `${SHIM_DIR}\\claude.cmd`],
    }));
    assert.equal(resolved.command, path.join(SHIM_DIR, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
    assert.deepEqual(resolved.prependArgs, []);
  });

  it('honours an operator executable override that exists', async () => {
    const resolved = await resolveCliExecutable('node', {
      platform: 'win32',
      env: { CLIHIVE_NODE_BIN: process.execPath },
      which: () => [],
    });
    assert.equal(resolved.command, process.execPath);
    assert.match(resolved.resolvedFrom, /^env:/);
  });

  it('rejects a missing override, a missing CLI, and unspawnable shims', async () => {
    await assert.rejects(resolveCliExecutable('node', { platform: 'win32', env: { CLIHIVE_NODE_BIN: 'C:\\nope\\node.exe' }, which: () => [] }), CliNotFoundError);
    await assert.rejects(resolveCliExecutable('ghost', winResolver({})), /not found on PATH/);
    await assert.rejects(resolveCliExecutable('tool', winResolver({
      tool: [`${SHIM_DIR}\\tool`, `${SHIM_DIR}\\tool.cmd`],
    }, null)), /none can be spawned safely|missing/);
  });
});

describe('resolveCliExecutable (posix)', () => {
  it('spawns the PATH entry directly', async () => {
    const resolved = await resolveCliExecutable('codex', {
      platform: 'linux',
      env: {},
      which: () => ['/usr/local/bin/codex'],
      readShim: async () => { throw new Error('unused'); },
    });
    assert.equal(resolved.command, '/usr/local/bin/codex');
    assert.deepEqual(resolved.prependArgs, []);
  });
});
