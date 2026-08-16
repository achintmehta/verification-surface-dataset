const { execSync } = require('child_process');
try {
    execSync('node run_install.js', { stdio: 'inherit' });
} catch (e) {
    console.error(e);
}
