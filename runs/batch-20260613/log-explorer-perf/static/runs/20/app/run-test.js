const { execSync } = require('child_process');
try {
  execSync('npm install', { stdio: 'inherit', cwd: __dirname });
  execSync('npm install', { stdio: 'inherit', cwd: __dirname + '/backend' });
  execSync('node test-pglite.js', { stdio: 'inherit', cwd: __dirname });
} catch (e) {
  console.error(e);
}
