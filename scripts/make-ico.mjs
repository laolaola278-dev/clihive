// Assemble a multi-size Windows .ico from PNG files.
//
//   node scripts/make-ico.mjs
//
// Windows Vista+ accepts PNG-compressed icon entries, which keeps the alpha
// channel exact and avoids the 256-colour quantization of the legacy BMP path.
// Reads .iconbuild/icon-<size>.png and writes icon.ico at the repo root.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sizes = [16, 32, 48, 64, 128, 256];
const srcDir = path.join(root, '.iconbuild');

const entries = sizes.map((size) => {
  const file = path.join(srcDir, `icon-${size}.png`);
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  const png = readFileSync(file);
  // sanity-check the PNG signature so a renamed non-PNG fails loudly
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);
  return { size, png };
});

// ICONDIR: reserved(2) type(2) count(2)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);              // reserved
header.writeUInt16LE(1, 2);              // 1 = icon
header.writeUInt16LE(entries.length, 4);

// ICONDIRENTRY is 16 bytes; image data starts after the whole directory.
let offset = 6 + entries.length * 16;
const directory = Buffer.alloc(entries.length * 16);
entries.forEach((entry, i) => {
  const base = i * 16;
  directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 0); // 0 means 256
  directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1);
  directory.writeUInt8(0, base + 2);     // palette size (0 = no palette)
  directory.writeUInt8(0, base + 3);     // reserved
  directory.writeUInt16LE(1, base + 4);  // colour planes
  directory.writeUInt16LE(32, base + 6); // bits per pixel
  directory.writeUInt32LE(entry.png.length, base + 8);
  directory.writeUInt32LE(offset, base + 12);
  offset += entry.png.length;
});

const ico = Buffer.concat([header, directory, ...entries.map((e) => e.png)]);
const out = path.join(root, 'icon.ico');
writeFileSync(out, ico);

process.stdout.write(`icon.ico written: ${entries.length} sizes (${sizes.join(', ')}), ${(ico.length / 1024).toFixed(1)} KB\n`);
