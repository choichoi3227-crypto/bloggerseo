import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['worker.js', 'src', 'scripts', 'test'];
const files = [];
function walk(path) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry === 'node_modules' || entry === '.wrangler') continue;
      walk(join(path, entry));
    }
  } else if (/\.(?:mjs|js)$/.test(path)) {
    files.push(path);
  }
}
for (const root of roots) walk(root);

for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
console.log(`Syntax lint passed for ${files.length} JavaScript files.`);
