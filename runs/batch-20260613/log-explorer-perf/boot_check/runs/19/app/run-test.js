const { execSync } = require('child_process');
try {
  const output = execSync('node test-perf.js', { encoding: 'utf8' });
  console.log(output);
} catch (e) {
  console.error(e.stdout);
  console.error(e.stderr);
}