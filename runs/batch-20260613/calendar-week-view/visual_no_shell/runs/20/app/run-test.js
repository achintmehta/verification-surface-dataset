const { execSync } = require('child_process');
execSync('node test-events.js', { stdio: 'inherit' });