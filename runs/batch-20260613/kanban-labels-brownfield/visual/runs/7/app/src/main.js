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
        .map((card) => ({ ...card, labels: [...(card.labels || [])] }))
        .filter((card) => {
          if (seen.has(card.id)) return false;
          seen.add(card.id);
          return true;
        })
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
      <div>
        <h2>Filter by labels</h2>
        <p>Choose one or more labels to show matching cards only. This does not change the board.</p>
      </div>
      <div class="filter-actions">
        <select id="label-filter" multiple size="${Math.min(Math.max(labels.length, 2), 5)}">
          ${labels.map((label) => `<option value="${escapeHtml(label.id)}" ${selectedLabelIds.has(label.id) ? 'selected' : ''}>${escapeHtml(label.name)}</option>`).join('')}
        </select>
        <button id="clear-filter" type="button" ${selectedLabelIds.size === 0 ? 'disabled' : ''}>Clear filter</button>
      </div>
    </div>
  `;
}

function renderLabelManager() {
  return `
    <details class="label-manager" open>
      <summary>Label manager</summary>
      <form id="create-label" class="create-label">
        <input name="name" type="text" maxlength="100" placeholder="New label name" autocomplete="off" />
        <input name="color" type="color" value="#2563eb" title="Label color" />
        <button type="submit">Create label</button>
      </form>
      <div class="label-list">
        ${labels.length === 0 ? '<p class="muted">No labels yet.</p>' : labels.map(renderLabelRow).join('')}
      </div>
    </details>
  `;
}

function renderLabelRow(label) {
  return `
    <form class="label-row" data-label-id="${escapeHtml(label.id)}">
      <span class="label-chip" style="--label-color: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
      <input name="name" type="text" maxlength="100" value="${escapeHtml(label.name)}" aria-label="Rename ${escapeHtml(label.name)}" />
      <input name="color" type="color" value="${escapeHtml(label.color)}" aria-label="Recolor ${escapeHtml(label.name)}" />
      <button type="submit">Save</button>
      <button class="danger" type="button" data-delete-label="${escapeHtml(label.id)}">Delete</button>
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
        ${visibleCards.length === 0 && column.cards.length > 0 ? '<p class="empty-filter">No cards match the selected labels.</p>' : ''}
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
        ${(card.labels || []).map((label) => `
          <button class="label-chip removable" type="button" data-unassign-label="${escapeHtml(label.id)}" data-card-id="${escapeHtml(card.id)}" style="--label-color: ${escapeHtml(label.color)}" title="Remove ${escapeHtml(label.name)}">
            ${escapeHtml(label.name)} <span aria-hidden="true">×</span>
          </button>
        `).join('')}
      </div>
      <form class="assign-label" data-card-id="${escapeHtml(card.id)}">
        <select name="labelId" ${available.length === 0 ? 'disabled' : ''}>
          <option value="">${available.length === 0 ? 'No labels to add' : 'Add label…'}</option>
          ${available.map((label) => `<option value="${escapeHtml(label.id)}">${escapeHtml(label.name)}</option>`).join('')}
        </select>
        <button type="submit" ${available.length === 0 ? 'disabled' : ''}>Add</button>
      </form>
    </article>
  `;
}

function bindEvents() {
  document.querySelector('#label-filter')?.addEventListener('change', (event) => {
    selectedLabelIds = new Set([...event.currentTarget.selectedOptions].map((option) => option.value));
    render();
    setStatus('Filter updated');
  });

  document.querySelector('#clear-filter')?.addEventListener('click', () => {
    selectedLabelIds.clear();
    render();
    setStatus('Filter cleared');
  });

  document.querySelector('#create-label')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await createLabel(form.elements.name.value, form.elements.color.value);
    form.reset();
    form.elements.color.value = '#2563eb';
  });

  document.querySelectorAll('.label-row').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await updateLabel(form.dataset.labelId, form.elements.name.value, form.elements.color.value);
    });
  });

  document.querySelectorAll('[data-delete-label]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (confirm('Delete this label and remove it from all cards?')) {
        await deleteLabel(button.dataset.deleteLabel);
      }
    });
  });

  document.querySelectorAll('.assign-label').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const labelId = form.elements.labelId.value;
      if (labelId) await assignLabel(form.dataset.cardId, labelId);
    });
  });

  document.querySelectorAll('[data-unassign-label]').forEach((button) => {
    button.addEventListener('click', async () => {
      await unassignLabel(button.dataset.cardId, button.dataset.unassignLabel);
    });
  });

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
      draggedCardId = null;
      cardEl.classList.remove('dragging');
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      if (!draggedCardId) return;
      event.preventDefault();
      const after = getDragAfterElement(list, event.clientY);
      const dragging = document.querySelector(`[data-card-id="${CSS.escape(draggedCardId)}"]`);
      if (!dragging) return;
      if (after == null) list.appendChild(dragging);
      else list.insertBefore(dragging, after);
      list.classList.add('drop-target');
    });
    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
      if (!cardId) return;
      const columnId = list.dataset.columnId;
      const { beforeId, afterId } = getNeighborsFromDom(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
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

function getNeighborsFromDom(list, cardId) {
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

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error((await response.json()).error || 'Request failed');
  return response.status === 204 ? null : response.json();
}

async function createCard(columnId, text) {
  try {
    await jsonRequest(`${API_BASE}/api/cards`, {
      method: 'POST',
      body: JSON.stringify({ columnId, text }),
    });
  } catch (error) {
    setStatus(`Create failed: ${error.message}`, true);
  }
}

async function createLabel(name, color) {
  try {
    await jsonRequest(`${API_BASE}/api/labels`, { method: 'POST', body: JSON.stringify({ name, color }) });
  } catch (error) {
    setStatus(`Label create failed: ${error.message}`, true);
  }
}

async function updateLabel(id, name, color) {
  try {
    await jsonRequest(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ name, color }) });
  } catch (error) {
    setStatus(`Label update failed: ${error.message}`, true);
  }
}

async function deleteLabel(id) {
  try {
    await jsonRequest(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (error) {
    setStatus(`Label delete failed: ${error.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    await jsonRequest(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, { method: 'POST', body: JSON.stringify({ labelId }) });
  } catch (error) {
    setStatus(`Assign label failed: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    await jsonRequest(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
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
  const card = { ...message.card, labels: [...(message.card.labels || [])] };
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
