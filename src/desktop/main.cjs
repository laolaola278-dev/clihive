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

function startServer() {
  const entry = resolveServerEntry();
  log(`server entry: ${entry}`);
  const nodeCmd = process.env.CLIHIVE_NODE || 'node';
  serverProcess = spawn(nodeCmd, [entry], {
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
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
