// Prove which icon a built exe actually carries.
//
//   node scripts/verify-icon.mjs <exe> [<exe> ...]
//
// icon.ico stores our artwork as PNG-compressed entries. If electron-builder
// embedded that file unchanged, those exact PNG byte sequences appear inside
// the exe. Searching for them is unambiguous evidence — much stronger than
// comparing re-rendered 32x32 thumbnails.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const icoPath = path.join(root, 'icon.ico');
if (!existsSync(icoPath)) throw new Error('icon.ico not found — run npm run icon first');
const ico = readFileSync(icoPath);

// Walk the ICONDIR to pull out each embedded PNG.
const count = ico.readUInt16LE(4);
const pngs = [];
for (let i = 0; i < count; i++) {
  const base = 6 + i * 16;
  const size = ico.readUInt32LE(base + 8);
  const offset = ico.readUInt32LE(base + 12);
  const blob = ico.subarray(offset, offset + size);
  const w = ico.readUInt8(base) || 256;
  if (blob.readUInt32BE(0) === 0x89504e47) pngs.push({ w, blob });
}
process.stdout.write(`icon.ico carries ${pngs.length} PNG entries: ${pngs.map((p) => p.w).join(', ')}\n\n`);

const targets = process.argv.slice(2);
if (targets.length === 0) {
  targets.push(path.join(root, 'dist', 'win-unpacked', 'clihive.exe'));
}

let allOk = true;
for (const target of targets) {
  if (!existsSync(target)) {
    process.stdout.write(`SKIP  ${target} (not built)\n`);
    continue;
  }
  const exe = readFileSync(target);
  const name = path.basename(target);
  const hits = pngs.filter((p) => exe.includes(p.blob));
  const missing = pngs.filter((p) => !exe.includes(p.blob));
  const ok = hits.length > 0;
  allOk = allOk && ok;
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'}  ${name}\n`
    + `      embedded our artwork: ${hits.length}/${pngs.length} sizes`
    + `${hits.length ? ` (${hits.map((h) => h.w).join(', ')})` : ''}\n`
    + `${missing.length ? `      not found as-is: ${missing.map((m) => m.w).join(', ')} (exe may have re-encoded them)\n` : ''}`,
  );
}

process.stdout.write(allOk ? '\nicon check: OK\n' : '\nicon check: FAILED\n');
process.exit(allOk ? 0 : 1);
