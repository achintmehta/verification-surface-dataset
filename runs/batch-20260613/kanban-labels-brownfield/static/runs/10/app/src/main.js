import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedLabelIds = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
}

function findCard(cardId) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) return { column, index, card: column.cards[index] };
  }
  return null;
}

function removeCardEverywhere(cardId) {
  let removed = null;
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) {
      const [card] = column.cards.splice(index, 1);
      removed = card;
    }
  }
  return removed;
}

function normalizeBoard(nextBoard) {
  const seen = new Set();
  const columns = [...(nextBoard.columns || [])]
    .map((column) => ({
      ...column,
      cards: [...(column.cards || [])]
        .filter((card) => {
          if (seen.has(card.id)) return false;
          seen.add(card.id);
          return true;
        })
        .map((card) => ({ ...card, labels: [...(card.labels || [])] }))
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  return { columns };
}

function normalizeLabels(nextLabels) {
  labels = [...(nextLabels || [])].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  selectedLabelIds = new Set([...selectedLabelIds].filter((id) => labels.some((label) => label.id === id)));
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function cardMatchesFilter(card) {
  if (selectedLabelIds.size === 0) return true;
  return (card.labels || []).some((label) => selectedLabelIds.has(label.id));
}

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <section class="label-panel">
      <div class="label-panel-section">
        <h2>Filter by labels</h2>
        ${renderFilterBar()}
      </div>
      <div class="label-panel-section">
        <h2>Labels</h2>
        ${renderLabelManager()}
      </div>
    </section>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderFilterBar() {
  if (labels.length === 0) return '<p class="muted">Create labels to filter cards.</p>';
  return `
    <div class="filter-bar">
      ${labels.map((label) => `
        <label class="filter-chip" style="--label-color: ${escapeAttr(label.color)}">
          <input type="checkbox" class="filter-label" value="${escapeAttr(label.id)}" ${selectedLabelIds.has(label.id) ? 'checked' : ''} />
          <span>${escapeHtml(label.name)}</span>
        </label>
      `).join('')}
      <button type="button" class="clear-filter" ${selectedLabelIds.size === 0 ? 'disabled' : ''}>Clear</button>
    </div>
  `;
}

function renderLabelManager() {
  return `
    <form class="create-label">
      <input name="name" type="text" maxlength="100" placeholder="New label" autocomplete="off" />
      <input name="color" type="color" value="#2563eb" title="Label color" />
      <button type="submit">Create</button>
    </form>
    <div class="label-list">
      ${labels.length === 0 ? '<p class="muted">No labels yet.</p>' : labels.map((label) => `
        <form class="label-row" data-label-id="${escapeAttr(label.id)}">
          <span class="label-swatch" style="background: ${escapeAttr(label.color)}"></span>
          <input name="name" type="text" maxlength="100" value="${escapeAttr(label.name)}" aria-label="Label name" />
          <input name="color" type="color" value="${escapeAttr(label.color)}" aria-label="Label color" />
          <button type="submit">Save</button>
          <button type="button" class="delete-label">Delete</button>
        </form>
      `).join('')}
    </div>
  `;
}

function renderColumn(column) {
  const cards = column.cards.filter(cardMatchesFilter);
  return `
    <section class="column" data-column-id="${escapeAttr(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeAttr(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeAttr(column.id)}">
        ${cards.map(renderCard).join('')}
        ${cards.length === 0 && column.cards.length > 0 ? '<p class="muted empty-filter">All cards hidden by filter.</p>' : ''}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const assignedIds = new Set((card.labels || []).map((label) => label.id));
  const available = labels.filter((label) => !assignedIds.has(label.id));
  return `
    <article class="card" draggable="true" data-card-id="${escapeAttr(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-labels">
        ${(card.labels || []).map((label) => `
          <span class="label-chip" style="--label-color: ${escapeAttr(label.color)}">
            ${escapeHtml(label.name)}
            <button type="button" class="remove-card-label" data-label-id="${escapeAttr(label.id)}" aria-label="Remove ${escapeAttr(label.name)}">×</button>
          </span>
        `).join('')}
      </div>
      <div class="card-label-actions">
        <select class="assign-label" aria-label="Assign a label" ${available.length === 0 ? 'disabled' : ''}>
          <option value="">${available.length === 0 ? 'No labels to add' : 'Add label…'}</option>
          ${available.map((label) => `<option value="${escapeAttr(label.id)}">${escapeHtml(label.name)}</option>`).join('')}
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

  document.querySelector('.create-label')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return setStatus('Label name is required', true);
    await createLabel(name, color);
    form.reset();
    form.elements.color.value = '#2563eb';
  });

  document.querySelectorAll('.label-row').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = form.elements.name.value.trim();
      const color = form.elements.color.value;
      if (!name) return setStatus('Label name is required', true);
      await updateLabel(form.dataset.labelId, name, color);
    });
    form.querySelector('.delete-label')?.addEventListener('click', async () => {
      const label = labels.find((item) => item.id === form.dataset.labelId);
      if (!label || !window.confirm(`Delete label "${label.name}" from all cards?`)) return;
      await deleteLabel(label.id);
    });
  });

  document.querySelectorAll('.filter-label').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedLabelIds.add(checkbox.value);
      else selectedLabelIds.delete(checkbox.value);
      render();
    });
  });
  document.querySelector('.clear-filter')?.addEventListener('click', () => {
    selectedLabelIds.clear();
    render();
  });

  document.querySelectorAll('.assign-label').forEach((select) => {
    select.addEventListener('click', (event) => event.stopPropagation());
    select.addEventListener('mousedown', (event) => event.stopPropagation());
    select.addEventListener('change', async () => {
      if (!select.value) return;
      const cardId = select.closest('.card')?.dataset.cardId;
      await assignLabel(cardId, select.value);
    });
  });
  document.querySelectorAll('.remove-card-label').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const cardId = button.closest('.card')?.dataset.cardId;
      await unassignLabel(cardId, button.dataset.labelId);
    });
  });

  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      if (event.target.closest('button, input, select, textarea')) {
        event.preventDefault();
        return;
      }
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
    });

    cardEl.addEventListener('dragend', () => {
      draggedCardId = null;
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.cards.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      if (!draggedCardId) return;
      event.preventDefault();
      list.classList.add('drop-target');
      const afterElement = getDragAfterElement(list, event.clientY);
      const dragging = document.querySelector(`.card[data-card-id="${cssEscape(draggedCardId)}"]`);
      if (!dragging) return;
      if (afterElement == null) list.appendChild(dragging);
      else list.insertBefore(dragging, afterElement);
    });

    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));

    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
      if (!cardId) return;
      const columnId = list.dataset.columnId;
      const { beforeId, afterId } = getSiblingIds(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
      await moveCard(cardId, columnId, beforeId, afterId);
    });
  });
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];
  return draggableElements.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
  } catch (error) {
    setStatus(`Move failed: ${error.message}`, true);
    await loadBoard();
  }
}

function getSiblingIds(list, cardId) {
  const ids = [...list.querySelectorAll('.card')].map((el) => el.dataset.cardId);
  const index = ids.indexOf(cardId);
  return {
    afterId: index > 0 ? ids[index - 1] : null,
    beforeId: index >= 0 && index < ids.length - 1 ? ids[index + 1] : null,
  };
}

function optimisticMove(cardId, columnId, beforeId, afterId) {
  const existing = removeCardEverywhere(cardId);
  if (!existing) return;
  const target = board.columns.find((column) => column.id === columnId);
  if (!target) return;
  const afterIndex = afterId ? target.cards.findIndex((card) => card.id === afterId) : -1;
  const beforeIndex = beforeId ? target.cards.findIndex((card) => card.id === beforeId) : -1;
  let insertAt = target.cards.length;
  if (afterIndex !== -1) insertAt = afterIndex + 1;
  else if (beforeIndex !== -1) insertAt = beforeIndex;
  target.cards.splice(insertAt, 0, { ...existing, column_id: columnId, optimistic: true });
}

async function createCard(columnId, text) {
  try {
    const response = await fetch(`${API_BASE}/api/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
  } catch (error) {
    setStatus(`Create failed: ${error.message}`, true);
  }
}

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create label failed');
  } catch (error) {
    setStatus(`Create label failed: ${error.message}`, true);
  }
}

async function updateLabel(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update label failed');
  } catch (error) {
    setStatus(`Update label failed: ${error.message}`, true);
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Delete label failed');
  } catch (error) {
    setStatus(`Delete label failed: ${error.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  if (!cardId || !labelId) return;
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Assign label failed');
  } catch (error) {
    setStatus(`Assign label failed: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  if (!cardId || !labelId) return;
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Remove label failed');
  } catch (error) {
    setStatus(`Remove label failed: ${error.message}`, true);
  }
}

function applyMutation(message) {
  if (message.labels) normalizeLabels(message.labels);

  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (!message.card) return;
  const card = message.card;
  removeCardEverywhere(card.id);
  const target = board.columns.find((column) => column.id === card.column_id || column.id === message.columnId);
  if (!target) return;
  target.cards.push(card);
  target.cards.sort(compareCards);
  render();
  setStatus('Synced');
}

async function loadBoard() {
  const [boardResponse, labelsResponse] = await Promise.all([
    fetch(`${API_BASE}/api/board`),
    fetch(`${API_BASE}/api/labels`),
  ]);
  if (!boardResponse.ok) throw new Error('Could not load board');
  if (!labelsResponse.ok) throw new Error('Could not load labels');
  board = normalizeBoard(await boardResponse.json());
  normalizeLabels(await labelsResponse.json());
  render();
}

function connectStream() {
  eventSource?.close();
  eventSource = new EventSource(`${API_BASE}/api/stream`);
  eventSource.addEventListener('connected', () => setStatus('Live'));
  eventSource.addEventListener('mutation', (event) => {
    applyMutation(JSON.parse(event.data));
  });
  eventSource.onerror = () => setStatus('Reconnecting…', true);
}

function setStatus(text, warn = false) {
  const status = document.querySelector('#status');
  if (status) {
    status.textContent = text;
    status.classList.toggle('warn', warn);
  }
  clearTimeout(statusTimer);
  if (warn) {
    statusTimer = setTimeout(() => setStatus(eventSource?.readyState === EventSource.OPEN ? 'Live' : 'Reconnecting…'), 4000);
  }
}

async function start() {
  app.innerHTML = '<div class="loading">Loading board…</div>';
  try {
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
