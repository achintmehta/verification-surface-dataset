import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

const bindEventsReplacement = `function bindEvents() {
  document.getElementById('manage-labels-btn')?.addEventListener('click', () => {
    isLabelManagerOpen = true;
    render();
  });

  document.getElementById('close-label-manager')?.addEventListener('click', () => {
    isLabelManagerOpen = false;
    editingLabelId = null;
    render();
  });

  document.getElementById('create-label-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return;
    try {
      const res = await fetch(\`\${API_BASE}/api/labels\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      form.reset();
    } catch (err) {
      alert(err.message);
    }
  });

  document.querySelectorAll('.edit-label-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      editingLabelId = btn.dataset.labelId;
      render();
    });
  });

  document.querySelectorAll('.cancel-edit-label').forEach(btn => {
    btn.addEventListener('click', () => {
      editingLabelId = null;
      render();
    });
  });

  document.querySelectorAll('.edit-label-form').forEach(form => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const labelId = form.dataset.labelId;
      const name = form.elements.name.value.trim();
      const color = form.elements.color.value;
      if (!name) return;
      try {
        const res = await fetch(\`\${API_BASE}/api/labels/\${encodeURIComponent(labelId)}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!res.ok) throw new Error((await res.json()).error);
        editingLabelId = null;
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll('.delete-label-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      if (!confirm('Delete this label?')) return;
      try {
        const res = await fetch(\`\${API_BASE}/api/labels/\${encodeURIComponent(labelId)}\`, {
          method: 'DELETE'
        });
        if (!res.ok) throw new Error((await res.json()).error);
      } catch (err) {
        alert(err.message);
      }
    });
  });

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

  document.getElementById('clear-filters-btn')?.addEventListener('click', () => {
    selectedLabelIds.clear();
    render();
  });

  document.querySelectorAll('.add-label-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      cardLabelMenuOpen = btn.dataset.cardId;
      render();
    });
  });

  document.querySelectorAll('.close-card-label-menu').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      cardLabelMenuOpen = null;
      render();
    });
  });

  document.querySelectorAll('.toggle-card-label').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      const cardId = cb.dataset.cardId;
      const labelId = cb.dataset.labelId;
      const isChecked = e.target.checked;
      try {
        const res = await fetch(\`\${API_BASE}/api/cards/\${encodeURIComponent(cardId)}/labels\${isChecked ? '' : \`/\${encodeURIComponent(labelId)}\`}\`, {
          method: isChecked ? 'POST' : 'DELETE',
          headers: isChecked ? { 'Content-Type': 'application/json' } : undefined,
          body: isChecked ? JSON.stringify({ labelId }) : undefined
        });
        if (!res.ok) throw new Error((await res.json()).error);
      } catch (err) {
        alert(err.message);
        e.target.checked = !isChecked; // revert
      }
    });
  });

  document.querySelectorAll('.add-card').forEach((form) => {`;

code = code.replace(/function bindEvents\(\) \{\n  document\.querySelectorAll\('\.add-card'\)\.forEach\(\(form\) => \{/, bindEventsReplacement);
fs.writeFileSync('src/main.js', code);
