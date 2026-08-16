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
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function normalizeBoard(nextBoard) {
  const seen = new Set();
  const columns = [...(nextBoard.columns || [])]
    .map((column) => ({
      ...column,
      cards: [...(column.cards || [])]
        .filter((card) => {
          if (!card?.id || seen.has(card.id)) return false;
          seen.add(card.id);
          return true;
        })
        .map((card) => ({ ...card, labels: Array.isArray(card.labels) ? card.labels : [] }))
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  return { columns };
}

function sortedLabels(nextLabels) {
  return [...(nextLabels || [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id));
}

function labelTextColor(color) {
  const hex = String(color || '#64748b').replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((char) => char + char).join('') : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111827' : '#ffffff';
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
      ${renderFilterBar()}
      ${renderLabelManager()}
    </section>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderFilterBar() {
  return `
    <div class="filter-bar">
      <strong>Filter by labels</strong>
      <div class="filter-options">
        ${labels.length === 0 ? '<span class="muted">No labels yet</span>' : labels.map((label) => `
          <label class="filter-chip" style="--label-color:${escapeHtml(label.color)}">
            <input type="checkbox" class="filter-label" value="${escapeHtml(label.id)}" ${selectedLabelIds.has(label.id) ? 'checked' : ''} />
            <span>${escapeHtml(label.name)}</span>
          </label>
        `).join('')}
      </div>
      <button type="button" class="clear-filters" ${selectedLabelIds.size === 0 ? 'disabled' : ''}>Clear</button>
    </div>
  `;
}

function renderLabelManager() {
  return `
    <details class="label-manager">
      <summary>Manage labels</summary>
      <form class="create-label label-row">
        <input name="name" type="text" maxlength="80" placeholder="New label name" autocomplete="off" />
        <input name="color" type="color" value="#2563eb" title="Label color" />
        <button type="submit">Create</button>
      </form>
      <div class="label-list">
        ${labels.length === 0 ? '<p class="muted">Create a label to tag cards.</p>' : labels.map(renderLabelEditor).join('')}
      </div>
    </details>
  `;
}

function renderLabelEditor(label) {
  return `
    <form class="edit-label label-row" data-label-id="${escapeHtml(label.id)}">
      <input name="name" type="text" maxlength="80" value="${escapeHtml(label.name)}" aria-label="Label name" />
      <input name="color" type="color" value="${escapeHtml(label.color)}" aria-label="Label color" />
      <button type="submit">Save</button>
      <button type="button" class="delete-label danger" data-label-id="${escapeHtml(label.id)}">Delete</button>
    </form>
  `;
}

function renderColumn(column) {
  const visibleCards = column.cards.filter(cardMatchesFilter);
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
  const assignedIds = new Set((card.labels || []).map((label) => label.id));
  const available = labels.filter((label) => !assignedIds.has(label.id));
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-labels">
        ${(card.labels || []).map((label) => renderCardLabel(card.id, label)).join('')}
      </div>
      <form class="assign-label card-action" data-card-id="${escapeHtml(card.id)}">
        <select name="labelId" ${available.length === 0 ? 'disabled' : ''}>
          <option value="">${available.length === 0 ? 'No labels to add' : 'Add label…'}</option>
          ${available.map((label) => `<option value="${escapeHtml(label.id)}">${escapeHtml(label.name)}</option>`).join('')}
        </select>
        <button type="submit" ${available.length === 0 ? 'disabled' : ''}>Add</button>
      </form>
    </article>
  `;
}

function renderCardLabel(cardId, label) {
  const color = label.color || '#64748b';
  return `
    <span class="label-chip" style="background:${escapeHtml(color)};color:${labelTextColor(color)}">
      ${escapeHtml(label.name)}
      <button type="button" class="remove-card-label card-action" data-card-id="${escapeHtml(cardId)}" data-label-id="${escapeHtml(label.id)}" aria-label="Remove label">×</button>
    </span>
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

  document.querySelectorAll('.edit-label').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await updateLabel(form.dataset.labelId, {
        name: form.elements.name.value.trim(),
        color: form.elements.color.value,
      });
    });
  });

  document.querySelectorAll('.delete-label').forEach((button) => {
    button.addEventListener('click', async () => {
      if (confirm('Delete this label from all cards?')) await deleteLabel(button.dataset.labelId);
    });
  });

  document.querySelectorAll('.filter-label').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedLabelIds.add(checkbox.value);
      else selectedLabelIds.delete(checkbox.value);
      render();
      setStatus('Filter updated');
    });
  });

  document.querySelector('.clear-filters')?.addEventListener('click', () => {
    selectedLabelIds = new Set();
    render();
    setStatus('Filter cleared');
  });

  document.querySelectorAll('.assign-label').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const labelId = form.elements.labelId.value;
      if (labelId) await assignLabel(form.dataset.cardId, labelId);
    });
  });

  document.querySelectorAll('.remove-card-label').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      await unassignLabel(button.dataset.cardId, button.dataset.labelId);
    });
  });

  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      if (event.target.closest('.card-action')) {
        event.preventDefault();
        return;
      }
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
    });
    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      draggedCardId = null;
      document.querySelectorAll('.cards.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      list.classList.add('drop-target');
      const afterElement = getDragAfterElement(list, event.clientY);
      const dragging = document.querySelector('.card.dragging');
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
      const { beforeId, afterId } = getNeighborIds(list, cardId);
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

function getNeighborIds(list, cardId) {
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

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) {
    let message = 'Request failed';
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function withStatus(action, successText) {
  try {
    const result = await action();
    if (successText) setStatus(successText);
    return result;
  } catch (error) {
    setStatus(error.message, true);
    return null;
  }
}

async function createCard(columnId, text) {
  try {
    await request('/api/cards', { method: 'POST', body: JSON.stringify({ columnId, text }) });
  } catch (error) {
    setStatus(`Create failed: ${error.message}`, true);
  }
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  try {
    await request(`/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
  } catch (error) {
    setStatus(`Move failed: ${error.message}`, true);
    await loadBoard();
  }
}

async function createLabel(name, color) {
  return withStatus(() => request('/api/labels', { method: 'POST', body: JSON.stringify({ name, color }) }), 'Label created');
}

async function updateLabel(labelId, updates) {
  return withStatus(() => request(`/api/labels/${encodeURIComponent(labelId)}`, { method: 'PUT', body: JSON.stringify(updates) }), 'Label saved');
}

async function deleteLabel(labelId) {
  return withStatus(async () => {
    selectedLabelIds.delete(labelId);
    return request(`/api/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
  }, 'Label deleted');
}

async function assignLabel(cardId, labelId) {
  return withStatus(() => request(`/api/cards/${encodeURIComponent(cardId)}/labels`, { method: 'POST', body: JSON.stringify({ labelId }) }), 'Label assigned');
}

async function unassignLabel(cardId, labelId) {
  return withStatus(() => request(`/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' }), 'Label removed');
}

function applyMutation(message) {
  if (Array.isArray(message.labels)) {
    labels = sortedLabels(message.labels);
    selectedLabelIds = new Set([...selectedLabelIds].filter((id) => labels.some((label) => label.id === id)));
  }

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
  target.cards.push({ ...card, labels: card.labels || [] });
  target.cards.sort(compareCards);
  render();
  setStatus('Synced');
}

async function loadBoard() {
  const [boardResponse, labelResponse] = await Promise.all([
    request('/api/board'),
    request('/api/labels'),
  ]);
  board = normalizeBoard(boardResponse);
  labels = sortedLabels(labelResponse);
  selectedLabelIds = new Set([...selectedLabelIds].filter((id) => labels.some((label) => label.id === id)));
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
