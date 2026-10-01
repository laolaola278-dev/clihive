// Browser-level verification of the window.
//
//   node scripts/verify-ui.mjs [--headed] [--shot <path>]
//
// Drives the real UI in Chromium against a real hive: opens panes, checks the
// grid renders live terminals, sends a message from one pane's keyboard, and
// verifies the orchestrator panel, the shared transcript, and the trace view
// all reflect it. Fails loudly on any console error or page exception.

import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';

import { chromium } from 'playwright-core';

import { HiveServer } from '../src/server/http.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const headed = argv.includes('--headed');
const shotIndex = argv.indexOf('--shot');
const shotPath = shotIndex !== -1 ? argv[shotIndex + 1] : path.join(root, '.artifacts', 'window.png');

/**
 * Reuse the Playwright browser already on this machine.
 * The layout under the cache differs per platform and build (`chrome-win64`,
 * `chrome-win`, `chrome-linux`, ...), so search rather than guess.
 */
function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH
    || (process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')
      : path.join(os.homedir(), '.cache', 'ms-playwright'));
  if (!existsSync(base)) return null;

  const wanted = process.platform === 'win32' ? 'chrome.exe' : 'chrome';
  const roots = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('chromium-'))
    .map((d) => path.join(base, d.name))
    .sort()
    .reverse();

  for (const root of roots) {
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const candidate = path.join(root, dir.name, wanted);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const home = await mkdtemp(path.join(os.tmpdir(), 'clihive-ui-'));
process.env.CLIHIVE_HOME = home;

const server = new HiveServer({ rootDir: root, port: 0, tracePath: path.join(home, 'trace.jsonl') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
function check(cond, label) {
  process.stdout.write(`${cond ? 'PASS' : 'FAIL'}  ${label}\n`);
  if (!cond) failed = true;
}

let browser;
try {
  const { url, token } = await server.listen();
  const executablePath = findChromium();
  if (!executablePath) throw new Error('no Chromium build found');

  browser = await chromium.launch({ executablePath, headless: !headed });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });

  /** @type {string[]} */
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto(`${url}/?token=${token}`, { waitUntil: 'domcontentloaded' });

  // --- boot ---------------------------------------------------------------
  await page.waitForFunction(() => document.getElementById('status')?.dataset.state === 'live',
    null, { timeout: 15000 });
  check(true, 'window connected over websocket');
  check(await page.locator('#grid-empty').isVisible(), 'empty state shown with no panes');

  // --- open panes ---------------------------------------------------------
  await page.selectOption('#new-pane-mode', 'display');
  await page.click('#add-pane');
  await page.waitForSelector('.pane[data-pane-id="p1"]', { timeout: 20000 });

  await page.selectOption('#new-pane-mode', 'stdin');
  await page.click('#add-pane');
  await page.waitForSelector('.pane[data-pane-id="p2"]', { timeout: 20000 });

  check(await page.locator('.pane').count() === 2, 'two panes in the grid');
  check(!(await page.locator('#grid-empty').isVisible()), 'empty state hidden once panes exist');
  check(await page.locator('.pane[data-pane-id="p2"] .pane-badge').textContent() === 'stdin',
    'pane badge shows its delivery mode');

  // A terminal is really rendering when xterm has painted rows.
  await page.waitForFunction(
    () => document.querySelectorAll('.pane[data-pane-id="p1"] .xterm-rows > div').length > 0,
    null, { timeout: 15000 },
  );
  check(true, 'xterm rendered rows inside the pane');

  await sleep(1500);
  const prompt = await page.locator('.pane[data-pane-id="p1"] .xterm-rows').innerText();
  check(prompt.trim().length > 0, 'shell output visible in the pane viewport');

  // --- type into a pane and broadcast ------------------------------------
  const marker = `ui${Date.now()}`;
  await page.locator('.pane[data-pane-id="p1"]').click();
  await page.keyboard.type(`hive send --to all "from the grid ${marker}"`);
  await page.keyboard.press('Enter');

  await page.waitForFunction(
    (m) => [...document.querySelectorAll('#shared-log .entry-body')].some((n) => n.textContent.includes(m)),
    marker, { timeout: 25000 },
  );
  check(true, 'keystrokes reached the PTY and the message hit the shared transcript');

  // --- the hideable orchestrator -----------------------------------------
  check(await page.locator('#orchestrator').getAttribute('data-open') === 'false',
    'orchestrator starts hidden');
  await page.click('#toggle-orch');
  await page.waitForFunction(
    () => document.getElementById('orchestrator')?.dataset.open === 'true',
    null, { timeout: 5000 },
  );
  const orchBox = await page.locator('#orchestrator').boundingBox();
  check(orchBox !== null && orchBox.x > 900, `orchestrator slid in on the right (x=${Math.round(orchBox?.x ?? -1)})`);

  // It must know the roster so it can address one pane.
  const options = await page.locator('#orch-target option').allTextContents();
  check(options.length === 3 && options[0].includes('all'),
    `target list holds all + each pane (${options.join(' | ')})`);

  // --- orchestrator -> every pane ----------------------------------------
  const orchMsg = `standup ${marker}`;
  await page.fill('#orch-input', orchMsg);
  await page.keyboard.press('Enter');

  await page.waitForFunction(
    (m) => [...document.querySelectorAll('#orch-log .entry-body')].some((n) => n.textContent.includes(m)),
    orchMsg, { timeout: 15000 },
  );
  check(true, 'orchestrator turn appears in its chat log');

  await page.waitForFunction(
    () => document.querySelectorAll('#orch-log .receipt[data-ok="true"]').length >= 2,
    null, { timeout: 15000 },
  );
  const receipts = await page.locator('#orch-log .receipt').allTextContents();
  check(receipts.some((r) => r.includes('display')) && receipts.some((r) => r.includes('pty')),
    `delivery receipts name the real channel per pane (${receipts.join(', ')})`);

  // The decisive one: the message is actually on screen in both panes.
  await page.waitForFunction(
    (m) => {
      const dense = (id) => (document.querySelector(`.pane[data-pane-id="${id}"] .xterm-rows`)?.innerText ?? '')
        .replace(/\s+/g, '');
      const needle = m.replace(/\s+/g, '');
      return dense('p1').includes(needle) && dense('p2').includes(needle);
    },
    orchMsg, { timeout: 20000 },
  );
  check(true, 'orchestrator message visible in both pane viewports');

  // --- mission-control chrome --------------------------------------------
  check(await page.locator('.sidebar').isVisible(), 'left workspace sidebar present');
  check((await page.locator('.titlebar').boundingBox()).height === 36, 'titlebar is 36px');
  check(await page.locator('#fleet').isVisible(), 'fleet roster visible in the deck');
  check((await page.locator('.fleet-row').count()) >= 2, 'fleet lists both panes');

  // palette
  await page.keyboard.press('Control+k');
  await page.waitForSelector('#palette:not([hidden])', { timeout: 5000 });
  check(true, 'command palette opens on Ctrl+K');
  await page.keyboard.press('Escape');

  // --- trace views --------------------------------------------------------
  await page.click('.dtab[data-tab="trace"]');
  await page.waitForSelector('#orch-trace .trace-row', { timeout: 10000 });
  const kinds = await page.locator('#orch-trace .trace-row').evaluateAll(
    (rows) => rows.map((r) => r.dataset.kind),
  );
  check(kinds.includes('msg.send') && kinds.includes('msg.deliver'),
    `trace panel shows the delivery chain (${[...new Set(kinds)].slice(0, 6).join(', ')})`);

  await page.fill('#trace-filter', 'msg.deliver');
  await sleep(400);
  const filtered = await page.locator('#orch-trace .trace-row').evaluateAll(
    (rows) => rows.map((r) => r.dataset.kind),
  );
  check(filtered.length > 0 && filtered.every((k) => k === 'msg.deliver'),
    `trace filter narrows to one kind (${filtered.length} rows)`);
  await page.fill('#trace-filter', '');

  await page.click('#toggle-trace');
  await page.waitForFunction(
    () => document.getElementById('trace-drawer')?.dataset.open === 'true',
    null, { timeout: 5000 },
  );
  check(await page.locator('#trace-log .trace-row').count() > 0, 'bottom trace drawer populated');

  // --- unread badge -------------------------------------------------------
  // Focus p1, then push a message to p2 from the server side; the badge must
  // light up on the unfocused pane.
  await page.locator('.pane[data-pane-id="p1"]').click();
  const pingMsg = `badge-${Date.now()}`;
  await server.orchestrator.dispatch({ to: 'p2', text: pingMsg, kind: 'chat' });
  await page.waitForFunction(
    () => !document.querySelector('.pane[data-pane-id="p2"] .pane-unread').hidden,
    null, { timeout: 10000 },
  );
  check(true, 'unread badge marks an unfocused pane that got a message');

  // --- layout sanity: panes must not be covered by the panel -------------
  const p1 = await page.locator('.pane[data-pane-id="p1"]').boundingBox();
  check(p1 !== null && orchBox !== null && p1.x + p1.width <= orchBox.x + 2,
    'grid reflowed beside the panel instead of being covered');

  // --- workspaces are a real view filter ---------------------------------
  const visiblePanes = () => page.evaluate(
    () => [...document.querySelectorAll('.pane:not([hidden])')].map((n) => n.dataset.paneId),
  );
  check((await visiblePanes()).length === 2, 'both panes visible in the default workspace');

  await page.click('#ws-add');
  await page.waitForFunction(
    () => document.getElementById('grid-empty-text')?.textContent === 'This workspace has no panes.',
    null, { timeout: 5000 },
  );
  check((await visiblePanes()).length === 0, 'new workspace starts empty and filters the grid');

  await page.click('#add-pane');
  await page.waitForSelector('.pane[data-pane-id="p3"]', { timeout: 15000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.pane:not([hidden])')].length === 1, null, { timeout: 5000 },
  );
  check((await visiblePanes()).join(',') === 'p3', 'a pane spawned in the new workspace lands there only');

  // Fleet must never hide a pane that lives in another workspace
  const fleetRows = await page.locator('.fleet-row').count();
  check(fleetRows === 3, `fleet still lists every pane across workspaces (${fleetRows})`);
  const wsTag = await page.locator('.fleet-row .fleet-ws').first().textContent();
  check(wsTag === 'main', `fleet tags panes from another workspace (${wsTag})`);

  // jumping to a pane elsewhere switches the workspace first
  await page.locator('.fleet-row', { hasText: 'cli-1' }).click();
  await page.waitForFunction(
    () => !document.querySelector('.pane[data-pane-id="p1"]').hidden
      && document.querySelector('.pane[data-pane-id="p3"]').hidden,
    null, { timeout: 5000 },
  );
  check((await visiblePanes()).sort().join(',') === 'p1,p2', 'fleet jump switched back to that pane\'s workspace');

  // --- appearance: theme + background (reload-sensitive, runs last) -------
  await page.click('#open-settings');
  await page.waitForSelector('#settings:not([hidden])', { timeout: 5000 });
  check(true, 'settings panel opens');

  await page.selectOption('#set-theme', 'matrix');
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === 'matrix', null, { timeout: 5000 },
  );
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  check(accent === '#00ff41', `matrix theme swaps accent to phosphor green (${accent})`);

  // background image upload (tiny generated PNG)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8//8/AzGAhShCAAD//wPzBAN6D9D7nwAAAABJRU5ErkJggg==',
    'base64',
  );
  await page.setInputFiles('#set-bg', { name: 'bg.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => document.body.classList.contains('has-bg'), null, { timeout: 5000 });
  const bgImg = await page.evaluate(() => document.getElementById('bg-layer').style.backgroundImage);
  check(bgImg.includes('data:image/png'), 'background image applied as data URL');

  // persistence across reload
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('status')?.dataset.state === 'live', null, { timeout: 15000 });
  const persisted = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    hasBg: document.body.classList.contains('has-bg'),
  }));
  check(persisted.theme === 'matrix' && persisted.hasBg, 'appearance persists across reload');

  // reset so a manual look afterwards starts clean
  await page.evaluate(() => {
    localStorage.removeItem('clihive.appearance');
  });

  await mkdir(path.dirname(shotPath), { recursive: true });
  await page.screenshot({ path: shotPath });
  process.stdout.write(`\nscreenshot: ${shotPath}\n`);

  check(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `: ${consoleErrors.slice(0, 3).join(' | ')}` : ''}`);
} catch (err) {
  failed = true;
  process.stdout.write(`FAIL  ${err.message}\n`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.close();
  await sleep(400);
  await rm(home, { recursive: true, force: true }).catch(() => {});
}

process.stdout.write(failed ? '\nui: FAILED\n' : '\nui: OK\n');
process.exit(failed ? 1 : 0);
