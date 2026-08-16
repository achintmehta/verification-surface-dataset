import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedLabelIds = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let currentStatus = { text: 'Connecting…', warn: false };

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
  const liveIds = new Set(labels.map((label) => label.id));
  selectedLabelIds = new Set([...selectedLabelIds].filter((id) => liveIds.has(id)));
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function compareLabels(a, b) {
  return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }) || String(a.id).localeCompare(String(b.id));
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
      <div id="status" class="status ${currentStatus.warn ? 'warn' : ''}">${escapeHtml(currentStatus.text)}</div>
    </header>
    <section class="labels-panel">
      <div class="filter-bar">
        <div>
          <h2>Filter by labels</h2>
          <p>Select one or more labels to show matching cards only. This affects only your view.</p>
        </div>
        <div class="filter-options">
          ${labels.length ? labels.map(renderFilterOption).join('') : '<span class="muted">No labels yet</span>'}
          ${selectedLabelIds.size ? '<button type="button" id="clear-filters" class="secondary">Clear filter</button>' : ''}
        </div>
      </div>
      <details class="label-manager">
        <summary>Manage labels</summary>
        <form id="create-label" class="create-label">
          <input name="name" type="text" maxlength="100" placeholder="New label name" autocomplete="off" required />
          <input name="color" type="color" value="#3b82f6" aria-label="Label color" />
          <button type="submit">Create label</button>
        </form>
        <div class="label-list">
          ${labels.length ? labels.map(renderLabelEditor).join('') : '<p class="muted">Create labels, then assign them from each card.</p>'}
        </div>
      </details>
    </section>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderFilterOption(label) {
  return `
    <label class="filter-option">
      <input type="checkbox" class="filter-label" value="${escapeAttr(label.id)}" ${selectedLabelIds.has(label.id) ? 'checked' : ''} />
      <span class="label-chip" style="--label-color: ${escapeAttr(label.color)}">${escapeHtml(label.name)}</span>
    </label>
  `;
}

function renderLabelEditor(label) {
  return `
    <form class="label-editor" data-label-id="${escapeAttr(label.id)}">
      <input name="name" type="text" maxlength="100" value="${escapeAttr(label.name)}" required />
      <input name="color" type="color" value="${escapeAttr(label.color)}" aria-label="Color for ${escapeAttr(label.name)}" />
      <button type="submit">Save</button>
      <button type="button" class="delete-label danger">Delete</button>
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
        ${!visibleCards.length && selectedLabelIds.size ? '<p class="empty-column">No cards match this filter.</p>' : ''}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const assigned = new Set((card.labels || []).map((label) => label.id));
  const available = labels.filter((label) => !assigned.has(label.id));
  return `
    <article class="card" draggable="true" data-card-id="${escapeAttr(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-labels">
        ${(card.labels || []).map((label) => renderCardLabel(card.id, label)).join('')}
      </div>
      <label class="assign-label">
        <span>Label</span>
        <select class="assign-label-select" data-card-id="${escapeAttr(card.id)}" ${available.length ? '' : 'disabled'}>
          <option value="">${available.length ? 'Add label…' : 'No labels to add'}</option>
          ${available.map((label) => `<option value="${escapeAttr(label.id)}">${escapeHtml(label.name)}</option>`).join('')}
        </select>
      </label>
    </article>
  `;
}

function renderCardLabel(cardId, label) {
  return `
    <span class="label-chip card-chip" style="--label-color: ${escapeAttr(label.color)}">
      ${escapeHtml(label.name)}
      <button type="button" class="remove-card-label" data-card-id="${escapeAttr(cardId)}" data-label-id="${escapeAttr(label.id)}" aria-label="Remove ${escapeAttr(label.name)}">×</button>
    </span>
  `;
}

function bindEvents() {
  document.querySelectorAll('.filter-label').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) selectedLabelIds.add(input.value);
      else selectedLabelIds.delete(input.value);
      render();
    });
  });

  document.querySelector('#clear-filters')?.addEventListener('click', () => {
    selectedLabelIds.clear();
    render();
  });

  document.querySelector('#create-label')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await createLabel(form.elements.name.value, form.elements.color.value);
    form.reset();
  });

  document.querySelectorAll('.label-editor').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await updateLabel(form.dataset.labelId, form.elements.name.value, form.elements.color.value);
    });
    form.querySelector('.delete-label').addEventListener('click', async () => {
      const label = labels.find((item) => item.id === form.dataset.labelId);
      if (!label || window.confirm(`Delete label "${label.name}" from all cards?`)) {
        await deleteLabel(form.dataset.labelId);
      }
    });
  });

  document.querySelectorAll('.assign-label-select').forEach((select) => {
    select.addEventListener('change', async () => {
      if (!select.value) return;
      await assignLabel(select.dataset.cardId, select.value);
    });
  });

  document.querySelectorAll('.remove-card-label').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      await unassignLabel(button.dataset.cardId, button.dataset.labelId);
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
      if (event.target.closest('button, input, select, textarea, label')) {
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
      document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      list.classList.add('drop-target');
      const afterElement = getDragAfterElement(list, event.clientY);
      const dragging = document.querySelector('.dragging');
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
      const { beforeId, afterId } = getNeighborsFromDom(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      try {
        const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
      } catch (error) {
        setStatus(`Move rejected: ${error.message}`, true);
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

async function requestJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error((await response.json()).error || 'Request failed');
  return response.json();
}

async function createLabel(name, color) {
  try {
    const label = await requestJson('/api/labels', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim(), color }),
    });
    if (!labels.some((item) => item.id === label.id)) normalizeLabels([...labels, label]);
    render();
    setStatus('Label created');
  } catch (error) {
    setStatus(`Label create failed: ${error.message}`, true);
  }
}

async function updateLabel(id, name, color) {
  try {
    const label = await requestJson(`/api/labels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ name: name.trim(), color }),
    });
    normalizeLabels(labels.map((item) => (item.id === id ? label : item)));
    render();
    setStatus('Label updated');
  } catch (error) {
    setStatus(`Label update failed: ${error.message}`, true);
  }
}

async function deleteLabel(id) {
  try {
    await requestJson(`/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    normalizeLabels(labels.filter((item) => item.id !== id));
    board = normalizeBoard({
      columns: board.columns.map((column) => ({
        ...column,
        cards: column.cards.map((card) => ({ ...card, labels: (card.labels || []).filter((label) => label.id !== id) })),
      })),
    });
    render();
    setStatus('Label deleted');
  } catch (error) {
    setStatus(`Label delete failed: ${error.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const card = await requestJson(`/api/cards/${encodeURIComponent(cardId)}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labelId }),
    });
    updateCardLocally(card);
    render();
    setStatus('Label assigned');
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const card = await requestJson(`/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
    updateCardLocally(card);
    render();
    setStatus('Label removed');
  } catch (error) {
    setStatus(`Remove failed: ${error.message}`, true);
  }
}

function updateCardLocally(card) {
  const found = findCard(card.id);
  if (found) found.column.cards[found.index] = { ...card, labels: card.labels || [] };
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
    if (message.labels) {
      render();
      setStatus('Synced');
    }
    return;
  }

  const card = { ...message.card, labels: message.card.labels || [] };
  removeCardEverywhere(card.id);
  const target = board.columns.find((column) => column.id === card.column_id || column.id === message.columnId);
  if (!target) return;
  target.cards.push(card);
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
  normalizeLabels(await response.json());
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
  currentStatus = { text, warn };
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
