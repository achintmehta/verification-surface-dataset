ction>
  `;
}

function cardMatchesFilter(card) {
  if (selectedLabelIds.size === 0) return true;
  const cardLabelIds = (card.labels || []).map(l => l.id);
  return cardLabelIds.some(id => selectedLabelIds.has(id));
}

function renderCard(card) {
  const cardLabels = card.labels || [];
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        ${cardLabels.map(label => `
          <span class="card-label" style="background-color: ${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">
            ${escapeHtml(label.name)}
            <button class="remove-label" data-label-id="${escapeHtml(label.id)}">&times;</button>
          </span>
        `).join('')}
      </div>
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-actions">
        <select class="assign-label">
          <option value="">Assign label...</option>
          ${labels.filter(l => !cardLabels.some(cl => cl.id === l.id)).map(l => `
            <option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>
          `).join('')}
        </select>
      </div>
    </article>
  `;
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
      if (event.target.tagName === 'SELECT' || event.target.tagName === 'BUTTON') {
        event.preventDefault();
        return;
      }
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain'