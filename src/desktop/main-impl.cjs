// clihive desktop shell (Electron)
// Starts the clihive server as a child process, waits for it to be ready,
// then opens a single window pointing at the local UI.
// Closing the window kills the server.

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = 7420;
const HOST = '127.0.0.1';
const TOKEN_DIR = path.join(app.getPath('home'), '.clihive');
const TOKEN_PATH = path.join(TOKEN_DIR, 'token');

let mainWindow = null;
let serverProcess = null;
let shuttingDown = false;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[clihive ${ts}] ${msg}\n`);
}

function pidAlive(pid) {
  try {
    if (process.platform === 'win32') {
      const { execFileSync } = require('child_process');
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'],
        { windowsHide: true, encoding: 'utf8' });
      return new RegExp(`\\b${pid}\\b`).test(out);
    }
    process.kill(pid, 0); // throws ESRCH when the pid is gone
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // permission denied => the process exists
  }
}

// A force-killed previous instance (taskkill /F, crash) leaves the collab
// writer lock behind and blocks startup. The lock may only be removed when its
// pid is verifiably dead — mirroring the store's own recovery contract.
function recoverStaleLock() {
  const lockPath = path.join(app.getPath('home'), '.clihive', 'collab', 'writer.lock');
  try {
    const obj = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (obj && Number.isInteger(obj.pid) && !pidAlive(obj.pid)) {
      fs.unlinkSync(lockPath);
      log(`removed stale writer lock (pid ${obj.pid} is dead)`);
    } else if (obj && Number.isInteger(obj.pid)) {
      log(`writer lock held by live pid ${obj.pid}; leaving it alone`);
    }
  } catch {
    // no lock file or unreadable — nothing to recover
  }
}

function readToken() {
  try {
    const raw = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj.token === 'string') return obj.token;
    } catch {
      // not JSON
    }
    return raw;
  } catch {
    return null;
  }
}

function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.request({ host: HOST, port: PORT, path: '/api/status', method: 'GET' }, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 500) {
          resolve(true);
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error(`server did not become ready within ${timeoutMs}ms (status ${res.statusCode})`));
        } else {
          setTimeout(tick, 300);
        }
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`server did not become ready within ${timeoutMs}ms`));
        } else {
          setTimeout(tick, 300);
        }
      });
      req.end();
    };
    tick();
  });
}

function resolveServerEntry() {
  const candidates = [
    path.join(process.resourcesPath || '', 'app.asar', 'src', 'server', 'index.js'),
    path.join(process.resourcesPath || '', 'app', 'src', 'server', 'index.js'),
    path.join(__dirname, '..', 'server', 'index.js'),
    path.join(__dirname, '..', '..', 'src', 'server', 'index.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`could not locate src/server/index.js (tried: ${candidates.join(', ')})`);
}

function bundledBinDir() {
  // In a packaged app (asar disabled) the repo's bin/ ships under resources/app/bin.
  // Prepending it to PATH makes `hive` available inside every pane without a
  // global npm install.
  const shim = process.platform === 'win32' ? 'hive.cmd' : 'hive';
  if (process.resourcesPath) {
    const p = path.join(process.resourcesPath, 'app', 'bin');
    if (fs.existsSync(path.join(p, shim))) return p;
  }
  const dev = path.join(__dirname, '..', '..', 'bin');
  return fs.existsSync(path.join(dev, shim)) ? dev : null;
}

function startServer() {
  const entry = resolveServerEntry();
  log(`server entry: ${entry}`);
  const nodeCmd = process.env.CLIHIVE_NODE || 'node';
  const env = { ...process.env, NODE_NO_WARNINGS: '1' };
  const bin = bundledBinDir();
  if (bin) {
    const sep = process.platform === 'win32' ? ';' : ':';
    env.PATH = bin + sep + (env.PATH || '');
    log(`PATH prepended with bundled bin: ${bin}`);
  }
  serverProcess = spawn(nodeCmd, [entry], {
    env,
    cwd: path.dirname(path.dirname(entry)),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProcess.stdout.on('data', (d) => log(`[server] ${d.toString().trimEnd()}`));
  serverProcess.stderr.on('data', (d) => log(`[server:err] ${d.toString().trimEnd()}`));
  serverProcess.on('exit', (code, signal) => {
    log(`server exited code=${code} signal=${signal}`);
    serverProcess = null;
    if (!shuttingDown && mainWindow) {
      dialog.showErrorBox('clihive', `Server exited unexpectedly (code ${code}). The window will close.`);
      app.quit();
    }
  });
}

function killServer() {
  if (!serverProcess) return;
  shuttingDown = true;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F'], { windowsHide: true });
    } else {
      serverProcess.kill('SIGTERM');
      setTimeout(() => {
        if (serverProcess) {
          try { serverProcess.kill('SIGKILL'); } catch {}
        }
      }, 2000);
    }
  } catch (err) {
    log(`killServer error: ${err.message}`);
  }
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open in Browser', click: () => {
          const token = readToken();
          const url = `http://${HOST}:${PORT}/?token=${encodeURIComponent(token || '')}`;
          shell.openExternal(url);
        }},
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  buildMenu();

  recoverStaleLock();
  startServer();
  log('waiting for server...');
  try {
    await waitForServer(30000);
    log('server ready');
  } catch (err) {
    dialog.showErrorBox('clihive', `Failed to start server: ${err.message}`);
    killServer();
    app.quit();
    return;
  }

  const token = readToken();
  const url = token
    ? `http://${HOST}:${PORT}/?token=${encodeURIComponent(token)}`
    : `http://${HOST}:${PORT}/`;

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'clihive',
    backgroundColor: '#1a1a1a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.loadURL(url);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  killServer();
  app.quit();
});

app.on('before-quit', () => {
  killServer();
});

app.on('activate', () => {
  if (mainWindow === null && serverProcess) {
    const token = readToken();
    const url = token
      ? `http://${HOST}:${PORT}/?token=${encodeURIComponent(token)}`
      : `http://${HOST}:${PORT}/`;
    mainWindow = new BrowserWindow({
      width: 1400, height: 900, title: 'clihive',
      backgroundColor: '#1a1a1a',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    mainWindow.loadURL(url);
  }
});
