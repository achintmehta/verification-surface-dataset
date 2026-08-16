import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

code = code.replace(
  /const wasOpen = dialog && dialog\.open;/,
  `const wasOpen = dialog && dialog.open;
  const openDropdown = document.querySelector('.label-dropdown:not(.hidden)');
  const openDropdownCardId = openDropdown ? openDropdown.dataset.cardId : null;`
);

code = code.replace(
  /if \(newDialog\) newDialog\.showModal\(\);\n  \}/,
  `if (newDialog) newDialog.showModal();
  }
  if (openDropdownCardId) {
    const newDropdown = document.querySelector(\`.label-dropdown[data-card-id="\${openDropdownCardId}"]\`);
    if (newDropdown) newDropdown.classList.remove('hidden');
  }`
);

fs.writeFileSync('src/main.js', code);
