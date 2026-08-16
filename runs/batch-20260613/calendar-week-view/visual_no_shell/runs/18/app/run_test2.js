const { execSync } = require('child_process');
try {
  execSync('node test.js', { stdio: 'inherit' });
} catch (e) {
  console.error(e);
}
