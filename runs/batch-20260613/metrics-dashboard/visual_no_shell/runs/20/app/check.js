const { execSync } = require('child_process');
try {
  execSync('node -c frontend/main.js');
  console.log('Syntax OK');
} catch (e) {
  console.log(e.message);
}
