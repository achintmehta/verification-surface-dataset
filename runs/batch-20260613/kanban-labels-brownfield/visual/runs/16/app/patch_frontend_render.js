import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

const renderReplacement = `function render() {
  app.innerHTML = \`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <button id="manage-labels-btn" class="btn">Manage Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    <div class="filter-bar">
      <span>Filter by labels:</span>
      <div class="filter-labels">
        \${labels.map(label => \`
          <label class="filter-label \${selectedLabelIds.has(label.id) ? 'selected' : ''}" style="--label-color: \${escapeHtml(label.color)}">
            <input type="checkbox" value="\${escapeHtml(label.id)}" \${selectedLabelIds.has(label.id) ? 'checked' : ''} class="filter-checkbox" />
            \${escapeHtml(label.name)}
          </label>
        \`).join('')}
        \${selectedLabelIds.size > 0 ? \`<button id="clear-filters-btn" class="btn-small">Clear</button>\` : ''}
      </div>
    </div>
    <main class="board">
      \${board.columns.map(renderColumn).join('')}
    </main>
    \${isLabelManagerOpen ? renderLabelManager() : ''}
  \`;
  bindEvents();
}

function renderLabelManager() {
  return \`
    <div class="modal-overlay" id="label-manager-overlay">
      <div class="modal">
        <div class="modal-header">
          <h2>Manage Labels</h2>
          <button id="close-label-manager" class="btn-close">&times;</button>
        </div>
        <div class="modal-body">
          <ul class="label-list">
            \${labels.map(label => \`
              <li class="label-item">
                \${editingLabelId === label.id ? \`
                  <form class="edit-label-form" data-label-id="\${escapeHtml(label.id)}">
                    <input type="text" name="name" value="\${escapeHtml(label.name)}" required />
                    <input type="color" name="color" value="\${escapeHtml(label.color)}" required />
                    <button type="submit" class="btn-small">Save</button>
                    <button type="button" class="btn-small cancel-edit-label">Cancel</button>
                  </form>
                \` : \`
                  <div class="label-display">
                    <span class="label-chip" style="background-color: \${escapeHtml(label.color)}">\${escapeHtml(label.name)}</span>
                    <div class="label-actions">
                      <button class="btn-small edit-label-btn" data-label-id="\${escapeHtml(label.id)}">Edit</button>
                      <button class="btn-small delete-label-btn" data-label-id="\${escapeHtml(label.id)}">Delete</button>
                    </div>
                  </div>
                \`}
              </li>
            \`).join('')}
          </ul>
          <form id="create-label-form" class="create-label-form">
            <input type="text" name="name" placeholder="New label name" required />
            <input type="color" name="color" value="#3b82f6" required />
            <button type="submit" class="btn">Create Label</button>
          </form>
        </div>
      </div>
    </div>
  \`;
}
`;

code = code.replace(/function render\(\) \{[\s\S]*?bindEvents\(\);\n\}/m, renderReplacement);
fs.writeFileSync('src/main.js', code);
