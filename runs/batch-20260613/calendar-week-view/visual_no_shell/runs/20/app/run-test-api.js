const { execSync } = require('child_process');
execSync('node test-api.js', { stdio: 'inherit' });
