const fs = require('fs');
const lines = fs.readFileSync('frontend/main.js', 'utf8').split('\n');
for (let i = 195; i < 215; i++) {
  if (lines[i] !== undefined) {
    console.log(\`\${i + 1}: \${lines[i]}\`);
  }
}
