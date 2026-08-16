import fs from 'fs';
let content = fs.readFileSync('src/main.js', 'utf8');

const renderStart = content.indexOf('function render() {');
const renderEnd = content.indexOf('function renderColumn(column) {');

const newRender = `function render() {
  const labelManagerOpen = document.getElementById('label-manager-dialog')?.open;
  const assignLabelOpen = document.getElementById('assign-label-dialog')?.open;
  const assignLabelCardId = document.querySelector('.assign-checkbox')?.dataset.cardId;

  app.innerHTML = \`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="controls">
      <div class="filter-bar">
        <strong>Filter:</strong>
        \${labels.map(l => \`
          <label>
            <input type="checkbox" class="filter-checkbox" value="\${escapeHtml(l.id)}" \${selectedLabelIds.has(l.id) ? 'checked' : ''}>
            <span class="label-chip" style="background-color: \${escapeHtml(l.color)}">\${escapeHtml(l.name)}</span>
          </label>
        \`).join('')}
        \${selectedLabelIds.size > 0 ? \`<button id="clear-filter">Clear</button>\` : ''}
      </div>
      <button id="manage-labels-btn">Manage Labels</button>
    </div>
    <main class="board">
      \${board.columns.map(renderColumn).join('')}
    </main>
    <dialog id="label-manager-dialog">
      <form method="dialog">
        <h2>Manage Labels</h2>
        <ul id="label-list">
          \${labels.map(l => \`
            <li>
              <input type="color" value="\${escapeHtml(l.color)}" data-id="\${escapeHtml(l.id)}" class="edit-label-color">
              <input type="text" value="\${escapeHtml(l.name)}" data-id="\${escapeHtml(l.id)}" class="edit-label-name">
              <button type="button" data-id="\${escapeHtml(l.id)}" class="delete-label-btn">Delete</button>
            </li>
          \`).join('')}
        </ul>
        <h3>Create Label</h3>
        <div class="create-label-form">
          <input type="color" id="new-label-color" value="#ff0000">
          <input type="text" id="new-label-name" placeholder="Label name">
          <button type="button" id="create-label-btn">Create</button>
        </div>
        <button type="submit">Close</button>
      </form>
    </dialog>
    <dialog id="assign-label-dialog">
      <form method="dialog">
        <h2>Assign Labels</h2>
        <div id="assign-label-list"></div>
        <button type="submit">Close</button>
      </form>
    </dialog>
  \`;
  bindEvents();

  if (labelManagerOpen) {
    document.getElementById('label-manager-dialog').showModal();
  }
  if (assignLabelOpen && assignLabelCardId) {
    const cardInfo = findCard(assignLabelCardId);
    if (cardInfo) {
      const card = cardInfo.card;
      const cardLabelIds = new Set((card.labels || []).map(l => l.id));
      const listHtml = labels.map(l => \`
        <label>
          <input type="checkbox" class="assign-checkbox" data-card-id="\${escapeHtml(assignLabelCardId)}" value="\${escapeHtml(l.id)}" \${cardLabelIds.has(l.id) ? 'checked' : ''}>
          <span class="label-chip" style="background-color: \${escapeHtml(l.color)}">\${escapeHtml(l.name)}</span>
        </label>
      \`).join('<br>');
      document.getElementById('assign-label-list').innerHTML = listHtml;
      
      document.querySelectorAll('.assign-checkbox').forEach(cb => {
        cb.addEventListener('change', async (ev) => {
          const lId = ev.target.value;
          const cId = ev.target.dataset.cardId;
          try {
            if (ev.target.checked) {
              await fetch(\`\${API_BASE}/api/cards/\${encodeURIComponent(cId)}/labels\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ labelId: lId })
              });
            } else {
              await fetch(\`\${API_BASE}/api/cards/\${encodeURIComponent(cId)}/labels/\${encodeURIComponent(lId)}\`, {
                method: 'DELETE'
              });
            }
          } catch (err) {
            alert(err.message);
          }
        });
      });
      document.getElementById('assign-label-dialog').showModal();
    }
  }
}

`;

content = content.slice(0, renderStart) + newRender + content.slice(renderEnd);
fs.writeFileSync('src/main.js', content);
