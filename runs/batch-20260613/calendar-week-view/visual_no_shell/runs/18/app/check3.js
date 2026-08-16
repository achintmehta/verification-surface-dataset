const fs = require('fs');
const code = fs.readFileSync('frontend/src/main.js', 'utf8');
const lines = code.split('\n');
for (let i = 270; i < 285; i++) {
  console.log(i + 1, lines[i]);
}
