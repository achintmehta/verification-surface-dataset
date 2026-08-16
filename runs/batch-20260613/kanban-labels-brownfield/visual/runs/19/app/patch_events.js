import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

const newEvents = `
  // Filter events
  document.querySelectorAll('.filter-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedLabelIds.add(e.target.value);
      } else {
        selectedLabelIds.delete(e.target.value);
      }
      render();
    });
  });

  const clearFilterBtn = document.querySelector('.clear-filter');
  if (clearFilterBtn) {
    clearFilterBtn.addEventListener('click', () => {
      selectedLabelIds.clear();
      render();
    });
  }

  // Manage labels dialog
  const manageLabelsBtn = document.querySelector('.manage-labels-btn');
  const dialog = document.querySelector('#label-manager-dialog');
  if (manageLabelsBtn && dialog) {
    manageLabelsBtn.addEventListener('click', () => {
      dialog.showModal();
    });
  }

  // Create label
  const createLabelBtn = document.querySelector('#create-label-btn');
  if (createLabelBtn) {
    createLabelBtn.addEventListener('click', async () => {
      const nameInput = document.querySelector('#new-label-name');
      const colorInput = document.querySelector('#new-label-color');
      const name = nameInput.value.trim();
      const color = colorInput.value;
      if (!name) return;
      try {
        const response = await fetch(\`\${API_BASE}/api/labels\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Create label failed');
        nameInput.value = '';
      } catch (error) {
        alert(error.message);
      }
    });
  }

  // Edit label
  document.querySelectorAll('.save-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const item = e.target.closest('.label-item');
      const id = item.dataset.labelId;
      const name = item.querySelector('.edit-label-name').value.trim();
      const color = item.querySelector('.edit-label-color').value;
      if (!name) return;
      try {
        const response = await fetch(\`\${API_BASE}/api/labels/\${id}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Update label failed');
      } catch (error) {
        alert(error.message);
      }
    });
  });

  // Delete label
  document.querySelectorAll('.delete-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const item = e.target.closest('.label-item');
      const id = item.dataset.labelId;
      try {
        const response = await fetch(\`\${API_BASE}/api/labels/\${id}\`, {
          method: 'DELETE'
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Delete label failed');
      } catch (error) {
        alert(error.message);
      }
    });
  });

  // Assign label dropdown toggle
  document.querySelectorAll('.assign-label-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      const dropdown = document.querySelector(\`.label-dropdown[data-card-id="\${cardId}"]\`);
      document.querySelectorAll('.label-dropdown').forEach(d => {
        if (d !== dropdown) d.classList.add('hidden');
      });
      dropdown.classList.toggle('hidden');
    });
  });

  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.label-dropdown') && !e.target.closest('.assign-label-btn')) {
      document.querySelectorAll('.label-dropdown').forEach(d => d.classList.add('hidden'));
    }
  });

  // Assign/unassign label
  document.querySelectorAll('.card-label-checkbox').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      const cardId = e.target.closest('.label-dropdown').dataset.cardId;
      const labelId = e.target.dataset.labelId;
      const checked = e.target.checked;
      try {
        if (checked) {
          const response = await fetch(\`\${API_BASE}/api/cards/\${cardId}/labels\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId })
          });
          if (!response.ok) throw new Error((await response.json()).error || 'Assign label failed');
        } else {
          const response = await fetch(\`\${API_BASE}/api/cards/\${cardId}/labels/\${labelId}\`, {
            method: 'DELETE'
          });
          if (!response.ok) throw new Error((await response.json()).error || 'Unassign label failed');
        }
      } catch (error) {
        alert(error.message);
        e.target.checked = !checked; // revert
      }
    });
  });
`;

code = code.replace(
  "function bindEvents() {",
  "function bindEvents() {\n" + newEvents
);

fs.writeFileSync('src/main.js', code);
