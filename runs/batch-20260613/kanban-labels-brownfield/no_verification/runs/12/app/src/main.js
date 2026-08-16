import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set(); // selected label ids (client-only view state)
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelManagerOpen = false;
let cardLabelEditorFor = null; // card id whose label popover is open

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
        .map((card) => ({ ...card, labels: card.labels || [] }))
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  return { columns };
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const id of activeFilter) {
    if (cardLabelIds.has(id)) return true;
  }
  return false;
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
    ${renderFilterBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${renderLabelManager()}
  `;
  bindEvents();
}

function renderFilterBar() {
  const chips = labels
    .map((label) => {
      const selected = activeFilter.has(label.id);
      return `
        <button
          type="button"
          class="filter-chip${selected ? ' selected' : ''}"
          data-filter-label-id="${escapeHtml(label.id)}"
          style="--label-color: ${escapeHtml(label.color)}"
        >
          <span class="chip-dot" style="background: ${escapeHtml(label.color)}"></span>
          ${escapeHtml(label.name)}
        </button>
      `;
    })
    .join('');

  return `
    <div class="filterbar">
      <div class="filterbar-left">
        <span class="filterbar-title">Filter by label:</span>
        <div class="filter-chips">
          ${chips || '<span class="filterbar-empty">No labels yet.</span>'}
        </div>
        ${activeFilter.size > 0 ? '<button type="button" class="clear-filter" id="clear-filter">Clear filter</button>' : ''}
      </div>
      <button type="button" class="manage-labels-btn" id="manage-labels">Manage labels</button>
    </div>
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
  const cardLabels = card.labels || [];
  const chips = cardLabels
    .map(
      (label) => `
      <span class="card-chip" style="background: ${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">
        ${escapeHtml(label.name)}
      </span>
    `
    )
    .join('');

  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      ${chips ? `<div class="card-chips">${chips}</div>` : ''}
      <div class="card-text">${escapeHtml(card.text)}</div>
      <button type="button" class="card-label-btn" data-card-label-btn="${escapeHtml(card.id)}" title="Edit labels">＋ labels</button>
      ${cardLabelEditorFor === card.id ? renderCardLabelEditor(card) : ''}
    </article>
  `;
}

function renderCardLabelEditor(card) {
  const assigned = new Set((card.labels || []).map((l) => l.id));
  const rows = labels
    .map((label) => {
      const isAssigned = assigned.has(label.id);
      return `
        <label class="label-editor-row">
          <input type="checkbox" data-toggle-card-id="${escapeHtml(card.id)}" data-toggle-label-id="${escapeHtml(label.id)}" ${isAssigned ? 'checked' : ''} />
          <span class="chip-dot" style="background: ${escapeHtml(label.color)}"></span>
          <span>${escapeHtml(label.name)}</span>
        </label>
      `;
    })
    .join('');

  return `
    <div class="card-label-editor" data-card-label-editor>
      <div class="card-label-editor-head">
        <strong>Labels</strong>
        <button type="button" class="close-editor" data-close-card-editor>✕</button>
      </div>
      ${rows || '<p class="label-editor-empty">No labels yet. Create some in “Manage labels”.</p>'}
    </div>
  `;
}

function renderLabelManager() {
  if (!labelManagerOpen) return '';
  const rows = labels
    .map(
      (label) => `
      <div class="label-row" data-label-row="${escapeHtml(label.id)}">
        <input type="color" class="label-color-input" value="${escapeHtml(label.color)}" data-recolor-id="${escapeHtml(label.id)}" />
        <input type="text" class="label-name-input" value="${escapeHtml(label.name)}" data-rename-id="${escapeHtml(label.id)}" maxlength="60" />
        <button type="button" class="label-delete-btn" data-delete-id="${escapeHtml(label.id)}">Delete</button>
      </div>
    `
    )
    .join('');

  return `
    <div class="modal-overlay" id="label-modal-overlay">
      <div class="modal" role="dialog" aria-label="Manage labels">
        <div class="modal-head">
          <h2>Manage labels</h2>
          <button type="button" class="close-modal" id="close-label-modal">✕</button>
        </div>
        <form class="create-label" id="create-label-form">
          <input type="color" name="color" value="#2563eb" class="label-color-input" />
          <input type="text" name="name" placeholder="New label name…" maxlength="60" autocomplete="off" />
          <button type="submit">Create</button>
        </form>
        <div class="label-list">
          ${rows || '<p class="label-list-empty">No labels yet.</p>'}
        </div>
        <p class="modal-hint">Rename or recolor edits save on blur / change.</p>
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
      const columnId = form.dataset.columnId;
      input.value = '';
      await createCard(columnId, text);
    });
  });

  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData('text/plain', draggedCardId);
      } catch {
        /* some browsers require this in a try */
      }
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
      event.dataTransfer.dropEffect = 'move';
      list.classList.add('drop-target');
      const afterEl = getDragAfterElement(list, event.clientY);
      const dragging = document.querySelector('.card.dragging');
      if (!dragging) return;
      if (afterEl == null) {
        list.appendChild(dragging);
      } else {
        list.insertBefore(dragging, afterEl);
      }
    });
    list.addEventListener('dragleave', (event) => {
      if (event.target === list) list.classList.remove('drop-target');
    });
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      const cardId = draggedCardId;
      if (!cardId) return;
      const columnId = list.dataset.columnId;
      const { afterId, beforeId } = getNeighbors(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      await moveCard(cardId, columnId, beforeId, afterId);
    });
  });

  // Filter bar
  document.querySelectorAll('[data-filter-label-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.filterLabelId;
      if (activeFilter.has(id)) activeFilter.delete(id);
      else activeFilter.add(id);
      render();
    });
  });
  document.querySelector('#clear-filter')?.addEventListener('click', () => {
    activeFilter.clear();
    render();
  });

  // Label manager open/close
  document.querySelector('#manage-labels')?.addEventListener('click', () => {
    labelManagerOpen = true;
    render();
  });
  document.querySelector('#close-label-modal')?.addEventListener('click', () => {
    labelManagerOpen = false;
    render();
  });
  document.querySelector('#label-modal-overlay')?.addEventListener('click', (event) => {
    if (event.target.id === 'label-modal-overlay') {
      labelManagerOpen = false;
      render();
    }
  });

  // Create label
  document.querySelector('#create-label-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = event.target.elements.name.value.trim();
    const color = event.target.elements.color.value;
    if (!name) {
      setStatus('Label name is required', true);
      return;
    }
    await createLabel(name, color);
  });

  // Rename / recolor / delete
  document.querySelectorAll('[data-rename-id]').forEach((input) => {
    input.addEventListener('change', async () => {
      const id = input.dataset.renameId;
      const name = input.value.trim();
      if (!name) {
        setStatus('Label name is required', true);
        return;
      }
      await updateLabel(id, { name });
    });
  });
  document.querySelectorAll('[data-recolor-id]').forEach((input) => {
    input.addEventListener('change', async () => {
      const id = input.dataset.recolorId;
      await updateLabel(id, { color: input.value });
    });
  });
  document.querySelectorAll('[data-delete-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteLabel(btn.dataset.deleteId);
    });
  });

  // Per-card label editor
  document.querySelectorAll('[data-card-label-btn]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = btn.dataset.cardLabelBtn;
      cardLabelEditorFor = cardLabelEditorFor === id ? null : id;
      render();
    });
  });
  document.querySelectorAll('[data-close-card-editor]').forEach((btn) => {
    btn.addEventListener('click', () => {
      cardLabelEditorFor = null;
      render();
    });
  });
  document.querySelectorAll('[data-toggle-label-id]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const cardId = checkbox.dataset.toggleCardId;
      const labelId = checkbox.dataset.toggleLabelId;
      if (checkbox.checked) await assignLabel(cardId, labelId);
      else await unassignLabel(cardId, labelId);
    });
  });
}

function getDragAfterElement(list, y) {
  const elements = [...list.querySelectorAll('.card:not(.dragging)')];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const child of elements) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, element: child };
    }
  }
  return closest.element;
}

function getNeighbors(list, cardId) {
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

async function moveCard(cardId, columnId, beforeId, afterId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
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

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create label failed');
    const form = document.querySelector('#create-label-form');
    if (form) form.elements.name.value = '';
  } catch (error) {
    setStatus(`Label error: ${error.message}`, true);
  }
}

async function updateLabel(id, fields) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update label failed');
  } catch (error) {
    setStatus(`Label error: ${error.message}`, true);
    await reloadAll();
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 204) {
      throw new Error((await response.json()).error || 'Delete label failed');
    }
    activeFilter.delete(id);
  } catch (error) {
    setStatus(`Label error: ${error.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Assign failed');
  } catch (error) {
    setStatus(`Label error: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Unassign failed');
  } catch (error) {
    setStatus(`Label error: ${error.message}`, true);
  }
}

function applyMutation(message) {
  if (Array.isArray(message.labels)) {
    labels = message.labels;
  }

  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (!message.card) {
    // Pure label list change (e.g. create) without a board payload.
    render();
    setStatus('Synced');
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
  labels = await response.json();
}

async function reloadAll() {
  await loadLabels();
  await loadBoard();
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
    await loadLabels();
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
