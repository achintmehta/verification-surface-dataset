const { execSync } = require('child_process');
try {
  execSync('node test_events.js', { stdio: 'inherit' });
} catch (e) {
  console.error(e);
}
