import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let openLabelMenuCardId = null;
let labelManagerOpen = false;

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

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <button id="manage-labels" class="ghost-btn" type="button">Manage labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${labelManagerOpen ? renderLabelManager() : ''}
  `;
  bindEvents();
}

function renderFilterBar() {
  return `
    <div class="filter-bar">
      <span class="filter-label">Filter:</span>
      ${labels.length === 0 ? '<span class="filter-empty">No labels yet</span>' : labels.map((label) => `
        <button type="button" class="filter-chip ${activeFilter.has(label.id) ? 'active' : ''}"
          data-filter-id="${escapeHtml(label.id)}"
          style="--chip-color:${escapeHtml(label.color)}">
          <span class="chip-dot"></span>${escapeHtml(label.name)}
        </button>
      `).join('')}
      ${activeFilter.size > 0 ? '<button type="button" id="clear-filter" class="ghost-btn small">Clear filter</button>' : ''}
    </div>
  `;
}

function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  return (card.labels || []).some((label) => activeFilter.has(label.id));
}

function renderLabelManager() {
  return `
    <div class="modal-overlay" data-modal="labels">
      <div class="modal">
        <div class="modal-head">
          <h2>Labels</h2>
          <button type="button" class="ghost-btn small" id="close-label-manager">Close</button>
        </div>
        <form class="label-create-form" id="label-create-form">
          <input type="color" name="color" value="#2563eb" />
          <input type="text" name="name" maxlength="100" placeholder="New label name…" autocomplete="off" />
          <button type="submit">Add label</button>
        </form>
        <ul class="label-list">
          ${labels.length === 0 ? '<li class="label-list-empty">No labels yet.</li>' : labels.map((label) => `
            <li class="label-row" data-label-id="${escapeHtml(label.id)}">
              <input type="color" class="label-color" value="${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}" />
              <input type="text" class="label-name" maxlength="100" value="${escapeHtml(label.name)}" data-label-id="${escapeHtml(label.id)}" />
              <button type="button" class="ghost-btn small danger" data-delete-label="${escapeHtml(label.id)}">Delete</button>
            </li>
          `).join('')}
        </ul>
      </div>
    </div>
  `;
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
    </section>
  `;
}

function renderCard(card) {
  const cardLabels = card.labels || [];
  const menuOpen = openLabelMenuCardId === card.id;
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${cardLabels.length > 0 ? `
        <div class="card-chips">
          ${cardLabels.map((label) => `
            <span class="chip" style="--chip-color:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">
              <span class="chip-dot"></span>${escapeHtml(label.name)}
              <button type="button" class="chip-remove" data-remove-label="${escapeHtml(label.id)}" data-card-id="${escapeHtml(card.id)}" title="Remove label">×</button>
            </span>
          `).join('')}
        </div>` : ''}
      <div class="card-actions">
        <button type="button" class="card-label-btn" data-label-menu="${escapeHtml(card.id)}">＋ Label</button>
      </div>
      ${menuOpen ? renderLabelPicker(card) : ''}
    </article>
  `;
}

function renderLabelPicker(card) {
  const assigned = new Set((card.labels || []).map((l) => l.id));
  return `
    <div class="label-picker" data-card-id="${escapeHtml(card.id)}">
      ${labels.length === 0 ? '<div class="label-picker-empty">No labels. Create one in “Manage labels”.</div>' : labels.map((label) => `
        <label class="label-picker-row" style="--chip-color:${escapeHtml(label.color)}">
          <input type="checkbox" data-toggle-label="${escapeHtml(label.id)}" data-card-id="${escapeHtml(card.id)}" ${assigned.has(label.id) ? 'checked' : ''} />
          <span class="chip-dot"></span>${escapeHtml(label.name)}
        </label>
      `).join('')}
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
    list.addEventListener('dragleave', (event) => {
      if (event.target === list) list.classList.remove('drop-target');
    });
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

  bindLabelEvents();
}

function bindLabelEvents() {
  document.querySelector('#manage-labels')?.addEventListener('click', () => {
    labelManagerOpen = true;
    openLabelMenuCardId = null;
    render();
  });

  // Filter chips
  document.querySelectorAll('[data-filter-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.filterId;
      if (activeFilter.has(id)) activeFilter.delete(id);
      else activeFilter.add(id);
      render();
    });
  });
  document.querySelector('#clear-filter')?.addEventListener('click', () => {
    activeFilter.clear();
    render();
  });

  // Open per-card label picker
  document.querySelectorAll('[data-label-menu]').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = el.dataset.labelMenu;
      openLabelMenuCardId = openLabelMenuCardId === id ? null : id;
      render();
    });
  });

  // Toggle label on card (from picker checkbox)
  document.querySelectorAll('[data-toggle-label]').forEach((el) => {
    el.addEventListener('change', async () => {
      const cardId = el.dataset.cardId;
      const labelId = el.dataset.toggleLabel;
      if (el.checked) await assignLabel(cardId, labelId);
      else await unassignLabel(cardId, labelId);
    });
  });

  // Remove chip from card
  document.querySelectorAll('[data-remove-label]').forEach((el) => {
    el.addEventListener('click', async (event) => {
      event.stopPropagation();
      await unassignLabel(el.dataset.cardId, el.dataset.removeLabel);
    });
  });

  // Prevent card drag when interacting with picker/actions
  document.querySelectorAll('.label-picker, .card-actions, .card-chips').forEach((el) => {
    el.addEventListener('dragstart', (event) => event.preventDefault());
  });

  // Label manager
  document.querySelector('#close-label-manager')?.addEventListener('click', () => {
    labelManagerOpen = false;
    render();
  });
  document.querySelector('[data-modal="labels"]')?.addEventListener('click', (event) => {
    if (event.target.dataset.modal === 'labels') {
      labelManagerOpen = false;
      render();
    }
  });
  document.querySelector('#label-create-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return;
    await createLabel(name, color);
  });
  document.querySelectorAll('.label-name').forEach((el) => {
    el.addEventListener('change', async () => {
      const value = el.value.trim();
      if (!value) {
        setStatus('Label name cannot be empty', true);
        await refreshLabels();
        render();
        return;
      }
      await updateLabel(el.dataset.labelId, { name: value });
    });
  });
  document.querySelectorAll('.label-color').forEach((el) => {
    el.addEventListener('change', async () => {
      await updateLabel(el.dataset.labelId, { color: el.value });
    });
  });
  document.querySelectorAll('[data-delete-label]').forEach((el) => {
    el.addEventListener('click', async () => {
      await deleteLabel(el.dataset.deleteLabel);
    });
  });
}

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
  } catch (error) {
    setStatus(`Label create failed: ${error.message}`, true);
  }
}

async function updateLabel(id, fields) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update failed');
  } catch (error) {
    setStatus(`Label update failed: ${error.message}`, true);
    await refreshLabels();
    render();
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 204) throw new Error((await response.json()).error || 'Delete failed');
  } catch (error) {
    setStatus(`Label delete failed: ${error.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Assign failed');
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Unassign failed');
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
  }
}

async function refreshLabels() {
  try {
    const response = await fetch(`${API_BASE}/api/labels`);
    if (!response.ok) throw new Error('Could not load labels');
    const data = await response.json();
    labels = data.labels || [];
  } catch (error) {
    // keep existing labels
  }
}

function pruneFilter() {
  const ids = new Set(labels.map((l) => l.id));
  for (const id of [...activeFilter]) {
    if (!ids.has(id)) activeFilter.delete(id);
  }
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

function applyMutation(message) {
  if (Array.isArray(message.labels)) {
    labels = message.labels;
    pruneFilter();
  }

  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (!message.card) {
    // e.g. label-create with no board payload
    render();
    setStatus('Synced');
    return;
  }
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
  const [boardResponse] = await Promise.all([
    fetch(`${API_BASE}/api/board`),
    refreshLabels(),
  ]);
  if (!boardResponse.ok) throw new Error('Could not load board');
  board = normalizeBoard(await boardResponse.json());
  pruneFilter();
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
