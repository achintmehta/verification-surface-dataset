import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

code = code.replace(
  /const openDropdownCardId = openDropdown \? openDropdown\.dataset\.cardId : null;/,
  `const openDropdownCardId = openDropdown ? openDropdown.dataset.cardId : null;
  const newLabelNameInput = document.querySelector('#new-label-name');
  const newLabelName = newLabelNameInput ? newLabelNameInput.value : '';
  const newLabelColorInput = document.querySelector('#new-label-color');
  const newLabelColor = newLabelColorInput ? newLabelColorInput.value : '#ff0000';`
);

code = code.replace(
  /if \(newDropdown\) newDropdown\.classList\.remove\('hidden'\);\n  \}/,
  `if (newDropdown) newDropdown.classList.remove('hidden');
  }
  const newNameInput = document.querySelector('#new-label-name');
  if (newNameInput && newLabelName) newNameInput.value = newLabelName;
  const newColorInput = document.querySelector('#new-label-color');
  if (newColorInput && newLabelColor) newColorInput.value = newLabelColor;`
);

fs.writeFileSync('src/main.js', code);
