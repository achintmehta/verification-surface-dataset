const { execSync } = require('child_process');
execSync('npm install puppeteer', { stdio: 'inherit' });
execSync('node scroll.js', { stdio: 'inherit' });