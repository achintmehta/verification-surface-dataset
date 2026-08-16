const { execSync } = require('child_process');
try {
    execSync('npm run install:all', { stdio: 'inherit' });
    console.log('Install complete');
} catch (e) {
    console.error(e);
}
