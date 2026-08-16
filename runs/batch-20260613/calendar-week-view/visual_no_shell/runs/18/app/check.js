const fs = require('fs');
try {
  const code = fs.readFileSync('frontend/src/main.js', 'utf8');
  require('vm').Script(code);
  console.log('Syntax OK');
} catch (e) {
  console.error(e);
}
