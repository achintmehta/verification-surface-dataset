s="controls">
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
}

function renderColumn(column) {
  const visibleCards = column.cards.filter(card => {
    if (selectedLabelIds.size === 0) r