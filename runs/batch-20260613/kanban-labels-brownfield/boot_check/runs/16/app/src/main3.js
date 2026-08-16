tton class="remove-label" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(l.id)}">&times;</button>
          </span>
        `).join('')}
        ${availableLabels.length > 0 ? `
          <select class="add-label-select" data-card-id="${escapeHtml(card.id)}">
            <option value="">+ Label</option>
            ${availableLabels.map(l => `
              <option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>
            `).join('')}
          </select>
        ` : ''}
      </div>
      <div class="card-text">${escapeHtml(card.text)}</div>
    </article>
  `;
}

function renderLabelManager() {
  return `
    <div class="modal-overlay" id="label-manager-modal">
      <div class="modal-content">
        <h2>Manage Labels</h2>
        <button id="close-label-manager">&times;</button>
        <ul class="label-list">
          ${labels.map(l => `
            <li>
              <form class="edit-label-form" data-label-id="${escapeHtml(l.id)}">
                <input type="color" name="color" value="${escapeHtml(l.color)}">
                <input type="text" name="name" value="${escapeHtml(l.name)}" required>
                <button type="submit">Save</button>
                <button type="button" class="delete-label" data-label-id="${escapeHtml(l.id)}">Delete</button>
              </form>
            </li>
          `).join('')}
        </ul>
        <form id="create-label-form">
          <h3>Create New Label</h3>
          <input type="color" name="color" value="#ff0000">
          <input type="text" name="name" placeholder="Label name" required>
          <button type="submit">Create</button>
        </form>
      </div>
    </div>
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
 