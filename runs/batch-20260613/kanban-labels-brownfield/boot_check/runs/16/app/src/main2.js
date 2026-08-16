n-label-manager">Manage Labels</button>
        <div id="label-filter" class="label-filter">
          ${labels.map(l => `
            <label class="filter-chip" style="background-color: ${selectedLabelIds.has(l.id) ? escapeHtml(l.color) : '#eee'}; color: ${selectedLabelIds.has(l.id) ? '#fff' : '#333'}">
              <input type="checkbox" class="filter-checkbox" value="${escapeHtml(l.id)}" ${selectedLabelIds.has(l.id) ? 'checked' : ''}>
              ${escapeHtml(l.name)}
            </label>
          `).join('')}
        </div>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${isLabelManagerOpen ? renderLabelManager() : ''}
  `;
  bindEvents();
}

function renderColumn(column) {
  const visibleCards = column.cards.filter(card => {
    if (selectedLabelIds.size === 0) return true;
    return card.labels?.some(l => selectedLabelIds.has(l.id));
  });

  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${visibleCards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const cardLabels = card.labels || [];
  const availableLabels = labels.filter(l => !cardLabels.some(cl => cl.id === l.id));
  
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        ${cardLabels.map(l => `
          <span class="label-chip" style="background-color: ${escapeHtml(l.color)}" title="${escapeHtml(l.name)}">
            ${escapeHtml(l.name)}
            <bu