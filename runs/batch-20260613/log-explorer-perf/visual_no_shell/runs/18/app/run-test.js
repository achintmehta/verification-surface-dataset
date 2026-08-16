import { execSync } from 'child_process';
try {
  console.log(execSync('node test-perf.js').toString());
} catch (e) {
  console.error(e.stdout ? e.stdout.toString() : e);
  console.error(e.stderr ? e.stderr.toString() : e);
}
