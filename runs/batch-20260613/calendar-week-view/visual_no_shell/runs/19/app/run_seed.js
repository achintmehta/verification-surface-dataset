const { execSync } = require('child_process');
try {
  execSync('node seed.js', { stdio: 'inherit' });
} catch (e) {
  console.error(e);
}
