="controls">
      <div class="filter-bar">
        <strong>Filter by labels:</strong>
        ${labels.map(label => `
          <label class="filter-label" style="--label-color: ${escapeHtml(label.color)}">
            <input type="checkbox" value="${escapeHtml(label.id)}" ${selectedLabelIds.has(label.id) ? 'checked' : ''} class="filter-checkbox" />
            ${escapeHtml(label.name)}
          </label>
        `).join('')}
        ${selectedLabelIds.size > 0 ? `<button class="clear-filter">Clear</button>` : ''}
      </div>
      <div class="label-manager">
        <strong>Manage Labels:</strong>
        <form class="add-label">
          <input name="name" type="text" placeholder="New label name" required />
          <input name="color" type="color" value="#ff0000" required />
          <button type="submit">Add Label</button>
        </form>
        <div class="label-list">
          ${labels.map(label => `
            <div class="label-item" data-label-id="${escapeHtml(label.id)}">
              <input type="text" class="edit-label-name" value="${escapeHtml(label.name)}" />
              <input type="color" class="edit-label-color" value="${escapeHtml(label.color)}" />
              <button class="delete-label">Delete</button>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderColumn(column) {
  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${column.cards.filter(cardMatchesFilter).map(renderCard).join('')}
      </div>
    </se