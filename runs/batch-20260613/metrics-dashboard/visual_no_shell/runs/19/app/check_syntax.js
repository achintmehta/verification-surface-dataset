const fs = require('fs');
const code = fs.readFileSync('frontend/main.js', 'utf8');
const lines = code.split('\n');
for (let i = 0; i < lines.length; i++) {
  try {
    new Function(lines.slice(0, i + 1).join('\n'));
  } catch (e) {
    if (e.message !== 'Unexpected end of input') {
      console.log('Error at line ' + (i + 1) + ': ' + e.message);
      console.log(lines[i]);
      break;
    }
  }
}
