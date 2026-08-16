import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

code = code.replace(
  /function render\(\) \{/,
  `function render() {
  const dialog = document.querySelector('#label-manager-dialog');
  const wasOpen = dialog && dialog.open;`
);

code = code.replace(
  /bindEvents\(\);\n\}/,
  `bindEvents();
  if (wasOpen) {
    const newDialog = document.querySelector('#label-manager-dialog');
    if (newDialog) newDialog.showModal();
  }
}`
);

fs.writeFileSync('src/main.js', code);
