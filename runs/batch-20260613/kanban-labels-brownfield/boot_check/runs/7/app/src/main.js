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
        .map((card) => ({ ...card, labels: [...(card.labels || [])].sort(compareLabels) }))
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  return { columns };
}

function normalizeLabels(nextLabels) {
  labels = [...(nextLabels || [])].sort(compareLabels);
  const validIds = new Set(labels.map((label) => label.id));
  selectedLabelIds = new Set([...selectedLabelIds].filter((id) => validIds.has(id)));
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function compareLabels(a, b) {
  return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }) || String(a.id).localeCompare(String(b.id));
}

function cardMatchesFilter(card) {
  if (selectedLabelIds.size === 0) return true;
  const ids = new Set((card.labels || []).map((label) => label.id));
  return [...selectedLabelIds].some((id) => ids.has(id));
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
    ${renderLabelTools()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderLabelTools() {
  return `
    <section class="label-tools">
      <div class="label-panel">
        <h2>Filter by labels</h2>
        <div class="filter-labels">
          ${labels.length ? labels.map(renderFilterLabel).join('') : '<span class="muted">No labels yet.</span>'}
        </div>
        <button class="clear-filter" type="button" ${selectedLabelIds.size ? '' : 'disabled'}>Clear filter</button>
      </div>
      <div class="label-panel">
        <h2>Label manager</h2>
        <form class="create-label">
          <input name="name" type="text" maxlength="80" placeholder="New label" autocomplete="off" />
          <input name="color" type="color" value="#2563eb" aria-label="Label color" />
          <button type="submit">Create</button>
        </form>
        <div class="label-list">
          ${labels.map(renderManagedLabel).join('')}
        </div>
      </div>
    </section>
  `;
}

function renderFilterLabel(label) {
  const checked = selectedLabelIds.has(label.id) ? 'checked' : '';
  return `
    <label class="filter-chip">
      <input type="checkbox" class="filter-label" value="${escapeAttr(label.id)}" ${checked} />
      <span class="label-chip" style="--label-color: ${escapeAttr(label.color)}">${escapeHtml(label.name)}</span>
    </label>
  `;
}

function renderManagedLabel(label) {
  return `
    <form class="managed-label" data-label-id="${escapeAttr(label.id)}">
      <span class="label-chip" style="--label-color: ${escapeAttr(label.color)}">${escapeHtml(label.name)}</span>
      <input name="name" type="text" maxlength="80" value="${escapeAttr(label.name)}" aria-label="Rename ${escapeAttr(label.name)}" />
      <input name="color" type="color" value="${escapeAttr(label.color)}" aria-label="Recolor ${escapeAttr(label.name)}" />
      <button type="submit">Save</button>
      <button type="button" class="delete-label">Delete</button>
    </form>
  `;
}

function renderColumn(column) {
  const visibleCards = column.cards.filter(cardMatchesFilter);
  return `
    <section class="column" data-column-id="${escapeAttr(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeAttr(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeAttr(column.id)}">
        ${visibleCards.map(renderCard).join('')}
        ${visibleCards.length === 0 && selectedLabelIds.size ? '<div class="empty-filter">No matching cards</div>' : ''}
      </div>
    </section>
  `;
}

function renderCard(card) {
  return `
    <article class="card" draggable="true" data-card-id="${escapeAttr(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${renderCardLabels(card)}
      ${renderCardLabelPicker(card)}
    </article>
  `;
}

function renderCardLabels(card) {
  const cardLabels = card.labels || [];
  if (cardLabels.length === 0) return '<div class="card-labels empty">No labels</div>';
  return `
    <div class="card-labels">
      ${cardLabels
        .map(
          (label) => `
            <span class="label-chip removable" style="--label-color: ${escapeAttr(label.color)}">
              ${escapeHtml(label.name)}
              <button type="button" class="unassign-label" data-label-id="${escapeAttr(label.id)}" aria-label="Remove ${escapeAttr(label.name)}">×</button>
            </span>`
        )
        .join('')}
    </div>
  `;
}

function renderCardLabelPicker(card) {
  const assigned = new Set((card.labels || []).map((label) => label.id));
  const available = labels.filter((label) => !assigned.has(label.id));
  if (available.length === 0) return '';
  return `
    <form class="assign-label" data-card-id="${escapeAttr(card.id)}">
      <select name="labelId" aria-label="Assign label">
        <option value="">Add label…</option>
        ${available.map((label) => `<option value="${escapeAttr(label.id)}">${escapeHtml(label.name)}</option>`).join('')}
      </select>
      <button type="submit">Add</button>
    </form>
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
      if (event.target.closest('button, input, select, form')) {
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
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      list.classList.add('drop-target');
      const dragging = document.querySelector('.card.dragging');
      if (!dragging) return;
      const after = getDragAfterElement(list, event.clientY);
      if (after == null) list.appendChild(dragging);
      else list.insertBefore(dragging, after);
    });
    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
      if (!cardId) return;
      const columnId = list.dataset.columnId;
      const { beforeId, afterId } = neighborIds(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
      await moveCard(cardId, columnId, beforeId, afterId);
    });
  });

  document.querySelector('.create-label')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return setStatus('Label name is required', true);
    form.elements.name.value = '';
    await createLabel(name, color);
  });

  document.querySelectorAll('.managed-label').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await updateLabel(form.dataset.labelId, form.elements.name.value.trim(), form.elements.color.value);
    });
    form.querySelector('.delete-label')?.addEventListener('click', async () => {
      if (confirm('Delete this label from all cards?')) await deleteLabel(form.dataset.labelId);
    });
  });

  document.querySelectorAll('.filter-label').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) selectedLabelIds.add(input.value);
      else selectedLabelIds.delete(input.value);
      render();
    });
  });
  document.querySelector('.clear-filter')?.addEventListener('click', () => {
    selectedLabelIds.clear();
    render();
  });

  document.querySelectorAll('.assign-label').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const labelId = form.elements.labelId.value;
      if (!labelId) return;
      await assignLabel(form.dataset.cardId, labelId);
    });
  });

  document.querySelectorAll('.unassign-label').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const cardId = button.closest('.card')?.dataset.cardId;
      if (!cardId) return;
      await unassignLabel(cardId, button.dataset.labelId);
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

function neighborIds(list, cardId) {
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

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) {
    let message = 'Request failed';
    try {
      message = (await response.json()).error || message;
    } catch {
      // ignore non-json bodies
    }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function createCard(columnId, text) {
  try {
    await api('/api/cards', { method: 'POST', body: JSON.stringify({ columnId, text }) });
  } catch (error) {
    setStatus(`Create failed: ${error.message}`, true);
  }
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  try {
    await api(`/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
  } catch (error) {
    setStatus(`Move failed: ${error.message}`, true);
    await loadBoard();
  }
}

async function createLabel(name, color) {
  try {
    await api('/api/labels', { method: 'POST', body: JSON.stringify({ name, color }) });
  } catch (error) {
    setStatus(`Label create failed: ${error.message}`, true);
  }
}

async function updateLabel(id, name, color) {
  try {
    await api(`/api/labels/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ name, color }) });
  } catch (error) {
    setStatus(`Label update failed: ${error.message}`, true);
  }
}

async function deleteLabel(id) {
  try {
    await api(`/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (error) {
    setStatus(`Label delete failed: ${error.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    await api(`/api/cards/${encodeURIComponent(cardId)}/labels`, { method: 'POST', body: JSON.stringify({ labelId }) });
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    await api(`/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
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

  if (!message.card) {
    if (message.labels) render();
    return;
  }
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
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
  render();
}

async function loadLabels() {
  const response = await fetch(`${API_BASE}/api/labels`);
  if (!response.ok) throw new Error('Could not load labels');
  const payload = await response.json();
  normalizeLabels(Array.isArray(payload) ? payload : payload.labels);
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
    await Promise.all([loadLabels(), loadBoard()]);
    render();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
