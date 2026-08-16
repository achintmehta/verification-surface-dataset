import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

// Add isLabelManagerOpen to state
code = code.replace(/let selectedLabels = new Set\(\);/, 'let selectedLabels = new Set();\nlet isLabelManagerOpen = false;');

// Update bindEvents to restore dialog state
const dialogStateReplacement = `
  // Label manager dialog
  const manageLabelsBtn = document.getElementById('manage-labels-btn');
  const labelManager = document.getElementById('label-manager');
  const closeLabelManagerBtn = document.getElementById('close-label-manager');

  if (isLabelManagerOpen && labelManager && !labelManager.open) {
    labelManager.showModal();
  }

  if (manageLabelsBtn && labelManager) {
    manageLabelsBtn.addEventListener('click', () => {
      isLabelManagerOpen = true;
      labelManager.showModal();
    });
  }

  if (closeLabelManagerBtn && labelManager) {
    closeLabelManagerBtn.addEventListener('click', () => {
      isLabelManagerOpen = false;
      labelManager.close();
    });
  }
`;
code = code.replace(/\/\/ Label manager dialog[\s\S]*?labelManager\.close\(\);\n    \}\);\n  \}/, dialogStateReplacement);

fs.writeFileSync('src/main.js', code);
