import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const roots = ['server', 'scripts', 'src'];
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full);
    else if (full.endsWith('.js')) files.push(full);
  }
}
for (const root of roots) walk(root);

for (const file of files) {
  // Browser modules can be parsed by Node's syntax checker even though DOM globals are unresolved at runtime.
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
  readFileSync(file, 'utf8');
}
console.log(`Syntax check passed for ${files.length} JavaScript files.`);
