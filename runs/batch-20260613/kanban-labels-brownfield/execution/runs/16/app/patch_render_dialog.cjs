const fs = require('fs');
let code = fs.readFileSync('src/main.js', 'utf8');

code = code.replace(
  /function render\(\) \{/,
  `function render() {
  const dialogWasOpen = document.getElementById('label-manager-dialog')?.open;`
);

code = code.replace(
  /bindEvents\(\);\n\}/,
  `bindEvents();
  if (dialogWasOpen) {
    document.getElementById('label-manager-dialog').showModal();
  }
}`
);

fs.writeFileSync('src/main.js', code);
