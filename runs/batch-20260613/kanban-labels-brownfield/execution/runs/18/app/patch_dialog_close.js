import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

const dialogCloseReplacement = `
  if (closeLabelManagerBtn && labelManager) {
    closeLabelManagerBtn.addEventListener('click', () => {
      isLabelManagerOpen = false;
      labelManager.close();
    });
  }

  if (labelManager) {
    labelManager.addEventListener('close', () => {
      isLabelManagerOpen = false;
    });
  }
`;
code = code.replace(/if \(closeLabelManagerBtn && labelManager\) \{\n    closeLabelManagerBtn\.addEventListener\('click', \(\) => \{\n      isLabelManagerOpen = false;\n      labelManager\.close\(\);\n    \}\);\n  \}/, dialogCloseReplacement);

fs.writeFileSync('src/main.js', code);
