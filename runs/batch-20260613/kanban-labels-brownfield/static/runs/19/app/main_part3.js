eturn true;
    return card.labels && card.labels.some(l => selectedLabelIds.has(l.id));
  });
  return \`
    <section class="column" data-column-id="\${escapeHtml(column.id)}">
      <h2>\${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="\${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="\${escapeHtml(column.id)}">
        \${visibleCards.map(renderCard).join('')}
      </div>
    </section>
  \`;
}

function renderCard(card) {
  const cardLabels = card.labels || [];
  return \`
    <article class="card" draggable="true" data-card-id="\${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        \${cardLabels.map(l => \`<span class="label-chip" style="background-color: \${escapeHtml(l.color)}" title="\${escapeHtml(l.name)}">\${escapeHtml(l.name)}</span>\`).join('')}
      </div>
      <div class="card-text">\${escapeHtml(card.text)}</div>
      <div class="card-actions">
        <button type="button" class="assign-label-btn" data-card-id="\${escapeHtml(card.id)}">🏷️</button>
      </div>
    </article>
  \`;
}

function bindEvents() {
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      await createCard(form.dataset.columnId, text);
    });
  });

  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
    });
    cardEl.addEventListener('dragend', () => {
      ca