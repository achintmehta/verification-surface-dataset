import fs from 'fs';

const content = fs.readFileSync('src/main.js', 'utf8');
const newContent = content.replace(
  'function render() {',
  \`function render() {
  const dialogWasOpen = document.getElementById('label-manager-dialog')?.open;\`
).replace(
  '  bindEvents();\n}',
  \`  bindEvents();
  if (dialogWasOpen) {
    const dialog = document.getElementById('label-manager-dialog');
    if (dialog) dialog.showModal();
  }
}\`
);

fs.writeFileSync('src/main.js', newContent);
