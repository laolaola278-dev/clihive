// clihive desktop entry.
//
// If Electron is started with ELECTRON_RUN_AS_NODE (some dev/CI environments
// export it), `require('electron')` resolves to the binary path instead of
// the app API and the real main module would crash on first use. Detect that
// mode and re-exec ourselves cleanly, with the variable removed.

if (process.env.ELECTRON_RUN_AS_NODE) {
  const { spawn } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, process.argv.slice(1), {
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('error', (err) => {
    try { console.error(`clihive: re-exec failed: ${err.message}`); } catch {}
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
} else {
  require('./main-impl.cjs');
}
