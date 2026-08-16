const { execSync } = require('child_process');
execSync('npm install puppeteer', { stdio: 'inherit' });
execSync('node test.js', { stdio: 'inherit' });
