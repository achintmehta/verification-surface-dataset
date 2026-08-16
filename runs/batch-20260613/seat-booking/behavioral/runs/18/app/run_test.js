import { execSync } from 'child_process';
import fs from 'fs';
try {
  const out = execSync('node test.js');
  fs.writeFileSync('test_output.txt', out);
} catch (e) {
  fs.writeFileSync('test_output.txt', e.stdout + '\n' + e.stderr);
}
