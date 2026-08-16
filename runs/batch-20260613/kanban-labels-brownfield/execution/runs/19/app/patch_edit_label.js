import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

code = code.replace(
  /function renderLabelItem\(label\) \{[\s\S]*?<\/div>\s*`;\s*\}/,
  `function renderLabelItem(label) {
  return \`
    <div class="label-item" data-label-id="\${escapeHtml(label.id)}">
      <input type="color" class="edit-label-color" value="\${escapeHtml(label.color)}" title="Change color" style="width:20px;height:20px;padding:0;border:none;cursor:pointer;" />
      <input type="text" class="edit-label-name" value="\${escapeHtml(label.name)}" title="Rename" style="border:none;background:transparent;width:80px;font-size:0.8rem;" />
      <button class="delete-label" title="Delete">×</button>
    </div>
  \`;
}`
);

const editEvents = `
  document.querySelectorAll('.edit-label-color').forEach(input => {
    input.addEventListener('change', async (e) => {
      const labelItem = e.target.closest('.label-item');
      const labelId = labelItem.dataset.labelId;
      const name = labelItem.querySelector('.edit-label-name').value.trim();
      const color = e.target.value;
      if (!name) return;
      try {
        const response = await fetch(\`\${API_BASE}/api/labels/\${labelId}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!response.ok) throw new Error('Failed to update label');
      } catch (error) {
        setStatus(\`Error: \${error.message}\`, true);
      }
    });
  });

  document.querySelectorAll('.edit-label-name').forEach(input => {
    input.addEventListener('change', async (e) => {
      const labelItem = e.target.closest('.label-item');
      const labelId = labelItem.dataset.labelId;
      const name = e.target.value.trim();
      const color = labelItem.querySelector('.edit-label-color').value;
      if (!name) return;
      try {
        const response = await fetch(\`\${API_BASE}/api/labels/\${labelId}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!response.ok) throw new Error('Failed to update label');
      } catch (error) {
        setStatus(\`Error: \${error.message}\`, true);
      }
    });
  });
`;

code = code.replace(
  "  document.querySelectorAll('.delete-label').forEach(btn => {",
  editEvents + "\n  document.querySelectorAll('.delete-label').forEach(btn => {"
);

fs.writeFileSync('src/main.js', code);
