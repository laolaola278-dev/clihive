// Capture the real clihive UI as screenshots for the README.
//
//   node scripts/screenshots.mjs
//
// Boots an in-process HiveServer (fake managed CLIs, like verify-ui.mjs),
// drives the real window in headless Chromium, and saves nine screenshots
// to screenshots/ named for the README gallery. Every screenshot shows
// genuine rendered state — live PTYs, real message delivery, real themes.

import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, statSync } from 'node:fs';

import { chromium } from 'playwright-core';

import { HiveServer } from '../src/server/http.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'screenshots');

/**
 * Reuse the Playwright browser already on this machine (same strategy as
 * verify-ui.mjs): search the cache instead of guessing the layout.
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

  for (const r of roots) {
    for (const dir of readdirSync(r, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const candidate = path.join(r, dir.name, wanted);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const home = await mkdtemp(path.join(os.tmpdir(), 'clihive-shot-'));
process.env.CLIHIVE_HOME = home;

const server = new HiveServer({
  rootDir: root,
  port: 0,
  tracePath: path.join(home, 'trace.jsonl'),
  collaboration: {
    resolveExecutable: async (name) => ({ command: `fake-${name}`, prependArgs: [], resolvedFrom: 'test' }),
    detect: async () => ({ available: true, version: 'fake-1.0' }),
    runTurnImpl: () => new Promise(() => {}),
    killTree: (child) => child.kill?.('SIGKILL'),
  },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const written = [];
async function shot(page, name) {
  const p = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: p });
  const kb = (statSync(p).size / 1024).toFixed(1);
  process.stdout.write(`shot  ${name}.png  (${kb} KB)\n`);
  written.push(p);
}

let failed = false;
function check(cond, label) {
  process.stdout.write(`${cond ? 'PASS' : 'FAIL'}  ${label}\n`);
  if (!cond) failed = true;
}

// Apply a theme through the real settings UI, then close the overlay so it
// does not cover the screenshot. Reuses the open panel across calls.
async function setTheme(page, theme) {
  const settingsOpen = await page.evaluate(() => !document.getElementById('settings').hidden);
  if (!settingsOpen) {
    await page.click('#open-settings');
    await page.waitForSelector('#settings:not([hidden])', { timeout: 5000 });
  }
  await page.selectOption('#set-theme', theme);
  await page.waitForFunction(
    (t) => document.documentElement.dataset.theme === t, theme, { timeout: 5000 });
  await page.click('#close-settings');
  await page.waitForFunction(
    () => document.getElementById('settings').hidden, null, { timeout: 5000 });
  await sleep(400); // let the transition finish
}

let browser;
try {
  const { url, token } = await server.listen();
  const executablePath = findChromium();
  check(executablePath !== null, `found local Chromium build${executablePath ? ` (${executablePath})` : ''}`);
  if (!executablePath) throw new Error('no Chromium build found');

  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto(`${url}/?token=${token}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('status')?.dataset.state === 'live',
    null, { timeout: 15000 });
  check(true, 'window connected over websocket');

  // --- two live panes -------------------------------------------------------
  await page.selectOption('#new-pane-mode', 'display');
  await page.click('#add-pane');
  await page.waitForSelector('.pane[data-pane-id="p1"]', { timeout: 20000 });
  await page.selectOption('#new-pane-mode', 'stdin');
  await page.click('#add-pane');
  await page.waitForSelector('.pane[data-pane-id="p2"]', { timeout: 20000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.pane[data-pane-id="p1"] .xterm-rows > div').length > 0,
    null, { timeout: 15000 });
  await sleep(1200);
  check(true, 'two panes rendering live terminals');

  // 01 — the default hero view: empty state gone, two panes, fleet roster.
  await shot(page, '01-main-interface');

  // --- a real round trip: keyboard -> PTY -> shared transcript --------------
  const marker = `shot${Date.now()}`;
  await page.locator('.pane[data-pane-id="p1"]').click();
  await page.keyboard.type(`hive send --to all "hello from pane p1 ${marker}"`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (m) => [...document.querySelectorAll('#shared-log .entry-body')].some((n) => n.textContent.includes(m)),
    marker, { timeout: 25000 });
  check(true, 'keystrokes reached the PTY and the message hit the shared transcript');

  // --- orchestrator open with real delivery receipts -------------------------
  await page.click('#toggle-orch');
  await page.waitForFunction(
    () => document.getElementById('orchestrator')?.dataset.open === 'true', null, { timeout: 5000 });
  const orchMsg = `standup ${marker}`;
  await page.fill('#orch-input', orchMsg);
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelectorAll('#orch-log .receipt[data-ok="true"]').length >= 2,
    null, { timeout: 15000 });
  await page.waitForFunction(
    (m) => {
      const dense = (id) => (document.querySelector(`.pane[data-pane-id="${id}"] .xterm-rows`)?.innerText ?? '')
        .replace(/\s+/g, '');
      return dense('p1').includes(m.replace(/\s+/g, ''))
        && dense('p2').includes(m.replace(/\s+/g, ''));
    },
    orchMsg, { timeout: 20000 });
  check(true, 'orchestrator message visible in both pane viewports with ok receipts');

  // 02 — amber graphite (the default theme) with the orchestrator open.
  await shot(page, '02-theme-amber');

  // 03/04/05 — the other themes, same real scene.
  await setTheme(page, 'matrix');
  await shot(page, '03-theme-matrix');
  await setTheme(page, 'void');
  await shot(page, '04-theme-void');
  await setTheme(page, 'neon');
  await shot(page, '05-theme-neon');
  await setTheme(page, 'amber');
  check(true, 'theme cycle captured and restored to amber');

  // --- hive CLI inside a pane -----------------------------------------------
  await page.locator('.pane[data-pane-id="p2"]').click();
  await page.keyboard.type('hive whoami');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => (document.querySelector('.pane[data-pane-id="p2"] .xterm-rows')?.innerText ?? '')
      .includes('in hive'),
    null, { timeout: 15000 });
  await sleep(800);
  check(true, 'hive whoami output rendered in pane p2');
  await shot(page, '09-pane-hive-cli');

  // --- the collaboration panel -----------------------------------------------
  const collabTab = page.locator('.dtab[data-tab="collab"]');
  await collabTab.click();
  await page.waitForSelector('.dpanel[data-panel="collab"].is-active', { timeout: 5000 });
  await page.selectOption('#ca-provider', 'codex');
  await page.fill('#ca-label', 'Shot Codex');
  await page.click('#collab-agent-form button[type="submit"]');
  await page.waitForFunction(
    () => document.querySelectorAll('#collab-agents .collab-row').length >= 1, null, { timeout: 10000 });
  await page.fill('#cr-objective', 'Screenshot run');
  await page.fill('#cr-criteria', 'Panel renders');
  await page.click('#collab-run-form button[type="submit"]');
  await page.waitForFunction(
    () => document.querySelectorAll('#collab-runs .collab-row-run').length >= 1, null, { timeout: 10000 });
  check(true, 'collab panel shows a registered agent and a created run');
  await shot(page, '06-collab-panel');

  // --- command palette --------------------------------------------------------
  await page.keyboard.press('Control+k');
  await page.waitForSelector('#palette:not([hidden])', { timeout: 5000 });
  await page.keyboard.type('theme');
  await sleep(400);
  check(true, 'command palette opened and filtered');
  await shot(page, '07-command-palette');
  await page.keyboard.press('Escape');

  // --- trace drawer -----------------------------------------------------------
  await page.click('.dtab[data-tab="trace"]');
  await page.waitForSelector('#orch-trace .trace-row', { timeout: 10000 });
  await page.click('#toggle-trace');
  await page.waitForFunction(
    () => document.getElementById('trace-drawer')?.dataset.open === 'true', null, { timeout: 5000 });
  check((await page.locator('#trace-log .trace-row').count()) > 0, 'bottom trace drawer populated');
  await shot(page, '08-trace-drawer');

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

process.stdout.write(`\n${written.length} screenshots in ${outDir}\n`);
process.stdout.write(failed ? 'screenshots: FAILED\n' : 'screenshots: OK\n');
process.exit(failed ? 1 : 0);
