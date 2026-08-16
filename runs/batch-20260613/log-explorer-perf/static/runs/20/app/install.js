const { execSync } = require('child_process');
execSync('npm install', { stdio: 'inherit', cwd: __dirname });
execSync('npm install', { stdio: 'inherit', cwd: __dirname + '/backend' });
