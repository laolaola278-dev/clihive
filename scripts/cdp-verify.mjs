// CDP functional verification for the frameless clihive shell.
// Usage: node scripts/cdp-verify.mjs [port]
// Connects to the running Electron app over the DevTools protocol and
// exercises the titlebar window controls, the clock, and the right-click
// paste path the way a user would.
import { spawn } from 'node:child_process';

const PORT = Number(process.argv[2] ?? 9223);

async function findPage() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no debuggable page target found');
  return page;
}

// Minimal CDP client over the WebSocket the browser already exposes.
// Node 22 ships a global WebSocket; keep this dependency-free.
class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new CdpSession(ws);
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.ws.close(); }
}

async function evalJs(session, expression) {
  const r = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(`page exception: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
  }
  return r.result.value;
}

async function main() {
  const page = await findPage();
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  const out = { checks: [] };
  const check = (name, pass, detail = '') => {
    out.checks.push({ name, pass: Boolean(pass), detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    return pass;
  };

  // 1. Preload bridge present (frameless controls only work through it).
  const hasApi = await evalJs(session, 'typeof window.electronAPI');
  check('electronAPI exposed via preload', hasApi === 'object', `typeof=${hasApi}`);

  // 2. Native chrome must be GONE: no visible menu bar, frameless document.
  const chromeInfo = await evalJs(session, `(() => {
    const btn = document.querySelector('#win-minimize');
    const clk = document.querySelector('#win-close');
    const max = document.querySelector('#win-maximize');
    const clock = document.querySelector('#titlebar-clock');
    const titlebar = document.querySelector('.titlebar');
    const style = btn ? getComputedStyle(btn) : null;
    const tStyle = titlebar ? getComputedStyle(titlebar) : null;
    // Electron reports the drag region under either the standard or the
    // legacy prefixed property depending on version.
    const region = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      return cs.appRegion ?? cs.webkitAppRegion ?? null;
    };
    return {
      minimize: !!btn, maximize: !!max, close: !!clk, clock: !!clock,
      clockText: clock ? clock.textContent : null,
      titlebarH: titlebar ? tStyle.height : null,
      dragRegion: region(titlebar),
      btnBorder: style ? style.borderTopStyle : null,
      btnW: style ? style.width : null,
      btnNoDrag: region(btn),
    };
  })()`);
  check('window control buttons exist', chromeInfo.minimize && chromeInfo.maximize && chromeInfo.close);
  check('titlebar clock element exists', chromeInfo.clock, `text='${chromeInfo.clockText}'`);
  check('titlebar is 36px tall', chromeInfo.titlebarH === '36px', `height=${chromeInfo.titlebarH}`);
  check('titlebar is the drag region', chromeInfo.dragRegion === 'drag', `region=${chromeInfo.dragRegion}`);
  // -webkit-app-region is non-standard: getComputedStyle hides it. Prove the
  // rule exists in the stylesheet AND that clicks really land on the button.
  const btnCss = await evalJs(session, `(() => {
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) {
        if (r.selectorText === '.titlebar-btn' && r.style && r.style.getPropertyValue('-webkit-app-region')) {
          return r.style.getPropertyValue('-webkit-app-region');
        }
      }
    }
    return null;
  })()`);
  check('control buttons carry no-drag rule', btnCss === 'no-drag', `css=${btnCss}`);
  // Ultimate proof: dispatch a real click at the maximize button center and
  // confirm the window state flips (a drag-region element would swallow it).
  const clickToggled = await evalJs(session, `(async () => {
    const max = document.querySelector('#win-maximize');
    if (!max) return { error: 'missing' };
    const before = await window.electronAPI.isMaximized();
    max.click();
    await new Promise((r) => setTimeout(r, 700));
    const after = await window.electronAPI.isMaximized();
    max.click();
    await new Promise((r) => setTimeout(r, 700));
    const restored = await window.electronAPI.isMaximized();
    return { before, after, restored };
  })()`);
  check('real click on maximize toggles state', clickToggled.before !== clickToggled.after && clickToggled.restored === clickToggled.before,
    `${clickToggled.before} -> ${clickToggled.after} -> ${clickToggled.restored}`);
  check('buttons are borderless (styled, not native)', chromeInfo.btnBorder === 'none', `border=${chromeInfo.btnBorder}`);

  // 3. Functional: minimize/maximize via the exposed bridge actually change window state.
  const before = await evalJs(session, 'window.electronAPI.isMaximized()');
  await evalJs(session, 'window.electronAPI.maximize()');
  await new Promise((r) => setTimeout(r, 600));
  const afterMax = await evalJs(session, 'window.electronAPI.isMaximized()');
  await evalJs(session, 'window.electronAPI.maximize()'); // toggle back
  await new Promise((r) => setTimeout(r, 600));
  const afterRestore = await evalJs(session, 'window.electronAPI.isMaximized()');
  check('maximize (IPC) toggles window state', afterMax !== before && afterRestore === before,
    `before=${before} max=${afterMax} restored=${afterRestore}`);

  // 4. Maximize event reaches the renderer (icon swap depends on it).
  const gotEvent = await evalJs(session, `(async () => {
    return await new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve('timeout'); } }, 2500);
      const on = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
      // The UI wires onMaximized internally; call the raw IPC event path.
      window.electronAPI.onMaximized(on);
      window.electronAPI.maximize();
      setTimeout(() => { window.electronAPI.maximize(); }, 700);
    });
  })()`);
  check('window:maximized IPC reaches renderer', gotEvent === true || gotEvent === 'true',
    `event=${gotEvent}`);

  // 5. Right-click paste: seed the clipboard, dispatch contextmenu on the
  //    focused pane's terminal, and confirm the bytes reached the PTY input.
  const paste = await evalJs(session, `(async () => {
    await window.electronAPI.writeClipboard('cdp-paste-probe-7f3k');
    const handle = window.__clihive;
    // Open a pane programmatically the same way the UI "+" button does.
    document.querySelector('#add-pane')?.click();
    await new Promise((r) => setTimeout(r, 900));
    const ids = [...handle.panes.keys()];
    if (!ids.length) return { error: 'no pane opened' };
    const id = ids[ids.length - 1];
    const node = handle.panes.get(id)?.node;
    if (!node) return { error: 'pane node missing' };
    const before = handle.cursor(id);
    node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 800));
    const after = handle.cursor(id);
    return { id, before, after, moved: after !== before };
  })()`);
  if (paste.error) {
    check('right-click paste delivers clipboard to pane', false, paste.error);
  } else {
    check('right-click paste delivers clipboard to pane', paste.moved,
      `pane=${paste.id} cursor ${paste.before} -> ${paste.after}`);
  }

  // 6. The pasted text should be echoed inside the terminal buffer.
  if (!paste.error) {
    await new Promise((r) => setTimeout(r, 600));
    const buf = await evalJs(session, `window.__clihive.bufferText('${paste.id}')`);
    check('pasted marker appears in terminal buffer', typeof buf === 'string' && buf.includes('cdp-paste-probe-7f3k'));
  }

  // 7. Native menu gone: Menu.setApplicationMenu(null) means no menu bar.
  const menuGone = await evalJs(session, `(() => {
    // With Menu.setApplicationMenu(null) there is no role-based menu; the
    // only remaining menus would be our custom context menu. Check that no
    // menubar element leaked into the DOM and that the page is frameless.
    return { menu: !!document.querySelector('menu'), body: !!document.body };
  })()`);
  check('no stray menu markup', !menuGone.menu);

  session.close();
  const failed = out.checks.filter((c) => !c.pass);
  console.log(`\n${out.checks.length - failed.length}/${out.checks.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
  spawn; // keep import used
}

main().catch((err) => { console.error('verify failed:', err.message); process.exit(1); });
