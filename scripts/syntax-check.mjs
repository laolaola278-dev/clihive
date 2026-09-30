// Syntax check: parse every JS file the project owns.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
let failed = 0;

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(full);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      try {
        execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
        console.log(`  OK  ${path.relative(root, full)}`);
      } catch (err) {
        failed += 1;
        console.log(`FAIL  ${path.relative(root, full)}: ${err.stderr?.toString().trim()}`);
      }
    }
  }
}

walk(root);
process.exit(failed > 0 ? 1 : 0);
