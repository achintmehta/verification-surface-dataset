const fs = require('fs');
let code = fs.readFileSync('src/main.js', 'utf8');

const newEvents = `
  document.querySelectorAll('.filter-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedLabels.add(e.target.value);
      } else {
        selectedLabels.delete(e.target.value);
      }
      render();
    });
  });

  const clearFilterBtn = document.getElementById('clear-filter');
  if (clearFilterBtn) {
    clearFilterBtn.addEventListener('click', () => {
      selectedLabels.clear();
      render();
    });
  }

  const manageLabelsBtn = document.getElementById('manage-labels-btn');
  if (manageLabelsBtn) {
    manageLabelsBtn.addEventListener('click', () => {
      document.getElementById('label-manager-dialog').showModal();
    });
  }

  const createLabelBtn = document.getElementById('create-label-btn');
  if (createLabelBtn) {
    createLabelBtn.addEventListener('click', async () => {
      const nameInput = document.getElementById('new-label-name');
      const colorInput = document.getElementById('new-label-color');
      const name = nameInput.value.trim();
      const color = colorInput.value;
      if (!name) return;
      try {
        const res = await fetch(\`\${API_BASE}/api/labels\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!res.ok) throw new Error('Failed to create label');
        nameInput.value = '';
      } catch (err) {
        alert(err.message);
      }
    });
  }

  document.querySelectorAll('.delete-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.dataset.id;
      try {
        const res = await fetch(\`\${API_BASE}/api/labels/\${id}\`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete label');
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll('.edit-label-name, .edit-label-color').forEach(input => {
    input.addEventListener('change', async (e) => {
      const id = e.target.dataset.id;
      const li = e.target.closest('li');
      const name = li.querySelector('.edit-label-name').value.trim();
      const color = li.querySelector('.edit-label-color').value;
      if (!name) return;
      try {
        const res = await fetch(\`\${API_BASE}/api/labels/\${id}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!res.ok) throw new Error('Failed to update label');
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll('.assign-label-select').forEach(select => {
    select.addEventListener('change', async (e) => {
      const labelId = e.target.value;
      if (!labelId) return;
      const cardId = e.target.dataset.cardId;
      try {
        const res = await fetch(\`\${API_BASE}/api/cards/\${cardId}/labels\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labelId })
        });
        if (!res.ok) throw new Error('Failed to assign label');
      } catch (err) {
        alert(err.message);
      }
      e.target.value = '';
    });
  });

  document.querySelectorAll('.remove-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const cardId = e.target.dataset.cardId;
      const labelId = e.target.dataset.labelId;
      try {
        const res = await fetch(\`\${API_BASE}/api/cards/\${cardId}/labels/\${labelId}\`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to remove label');
      } catch (err) {
        alert(err.message);
      }
    });
  });
`;

code = code.replace(
  /function bindEvents\(\) \{/,
  `function bindEvents() {\n${newEvents}`
);

fs.writeFileSync('src/main.js', code);
