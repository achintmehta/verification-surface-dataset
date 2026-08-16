const { execSync } = require('child_process');
execSync('node run-test-api.js', { stdio: 'inherit' });
