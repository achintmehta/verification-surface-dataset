const { exec } = require('child_process');

const install = exec('npm run install:all');
install.stdout.pipe(process.stdout);
install.stderr.pipe(process.stderr);

install.on('close', (code) => {
  console.log(`Install exited with code ${code}`);
  process.exit(code);
});
