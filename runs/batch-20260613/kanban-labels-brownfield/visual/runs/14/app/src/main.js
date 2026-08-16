import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelManagerOpen = false;
let openLabelMenuCardId = null;

const DEFAULT_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#0ea5e9', '#6366f1', '#a855f7', '#ec4899'];

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

function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  return (card.labels || []).some((label) => activeFilter.has(label.id));
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
  return `
    <div class="toolbar">
      <div class="filter-bar">
        <span class="filter-label">Filter:</span>
        ${labels.length === 0 ? '<span class="filter-empty">No labels yet</span>' : ''}
        ${labels
          .map(
            (label) => `
          <button type="button" class="chip filter-chip ${activeFilter.has(label.id) ? 'active' : ''}"
            data-filter-label-id="${escapeHtml(label.id)}"
            style="--chip-color: ${escapeHtml(label.color)}">
            <span class="chip-dot"></span>${escapeHtml(label.name)}
          </button>`
          )
          .join('')}
        ${activeFilter.size > 0 ? '<button type="button" class="clear-filter" id="clear-filter">Clear</button>' : ''}
      </div>
      <button type="button" class="manage-labels-btn" id="open-label-manager">Manage labels</button>
    </div>
  `;
}

function renderLabelManager() {
  if (!labelManagerOpen) return '';
  return `
    <div class="modal-overlay" id="label-manager-overlay">
      <div class="modal" role="dialog" aria-label="Manage labels">
        <div class="modal-header">
          <h2>Labels</h2>
          <button type="button" class="modal-close" id="close-label-manager" aria-label="Close">×</button>
        </div>
        <ul class="label-list">
          ${labels
            .map(
              (label) => `
            <li class="label-row" data-label-id="${escapeHtml(label.id)}">
              <input type="color" class="label-color" value="${escapeHtml(normalizeColorForInput(label.color))}" data-label-id="${escapeHtml(label.id)}" />
              <input type="text" class="label-name" value="${escapeHtml(label.name)}" maxlength="60" data-label-id="${escapeHtml(label.id)}" />
              <button type="button" class="label-save" data-label-id="${escapeHtml(label.id)}">Save</button>
              <button type="button" class="label-delete" data-label-id="${escapeHtml(label.id)}">Delete</button>
            </li>`
            )
            .join('')}
          ${labels.length === 0 ? '<li class="label-empty">No labels yet. Create one below.</li>' : ''}
        </ul>
        <form class="label-create" id="label-create-form">
          <input type="color" id="new-label-color" value="${DEFAULT_COLORS[labels.length % DEFAULT_COLORS.length]}" />
          <input type="text" id="new-label-name" placeholder="New label name" maxlength="60" autocomplete="off" />
          <button type="submit">Add label</button>
        </form>
        <div class="label-error" id="label-error"></div>
      </div>
    </div>
  `;
}

function normalizeColorForInput(color) {
  const value = String(color || '').trim();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    return '#' + value.slice(1).split('').map((c) => c + c).join('');
  }
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  return '#888888';
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
  const assignedIds = new Set(cardLabels.map((l) => l.id));
  const menuOpen = openLabelMenuCardId === card.id;
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${
        cardLabels.length
          ? `<div class="card-labels">${cardLabels
              .map(
                (label) => `
            <span class="chip card-chip" style="--chip-color: ${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">
              <span class="chip-dot"></span>${escapeHtml(label.name)}
              <button type="button" class="chip-remove" data-remove-card-id="${escapeHtml(card.id)}" data-remove-label-id="${escapeHtml(label.id)}" aria-label="Remove label">×</button>
            </span>`
              )
              .join('')}</div>`
          : ''
      }
      <div class="card-footer">
        <button type="button" class="add-label-btn" data-add-label-card-id="${escapeHtml(card.id)}">+ Label</button>
      </div>
      ${
        menuOpen
          ? `<div class="label-menu" data-label-menu-card-id="${escapeHtml(card.id)}">
              ${
                labels.length === 0
                  ? '<div class="label-menu-empty">No labels. Use “Manage labels”.</div>'
                  : labels
                      .map(
                        (label) => `
                <button type="button" class="label-menu-item ${assignedIds.has(label.id) ? 'assigned' : ''}"
                  data-toggle-card-id="${escapeHtml(card.id)}" data-toggle-label-id="${escapeHtml(label.id)}">
                  <span class="chip-dot" style="--chip-color: ${escapeHtml(label.color)}"></span>
                  ${escapeHtml(label.name)}
                  ${assignedIds.has(label.id) ? '<span class="check">✓</span>' : ''}
                </button>`
                      )
                      .join('')
              }
            </div>`
          : ''
      }
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

  bindLabelEvents();

  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      // Prevent dragging when interacting with label controls.
      if (event.target.closest('.chip-remove, .add-label-btn, .label-menu')) {
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

function bindLabelEvents() {
  // Filter chips
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
  document.querySelector('#open-label-manager')?.addEventListener('click', () => {
    labelManagerOpen = true;
    render();
  });
  document.querySelector('#close-label-manager')?.addEventListener('click', () => {
    labelManagerOpen = false;
    render();
  });
  document.querySelector('#label-manager-overlay')?.addEventListener('click', (event) => {
    if (event.target.id === 'label-manager-overlay') {
      labelManagerOpen = false;
      render();
    }
  });

  // Create label
  document.querySelector('#label-create-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = document.querySelector('#new-label-name').value.trim();
    const color = document.querySelector('#new-label-color').value;
    if (!name) {
      setLabelError('Name is required');
      return;
    }
    await createLabel(name, color);
  });

  // Save (rename/recolor) and delete in manager
  document.querySelectorAll('.label-save').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.labelId;
      const row = document.querySelector(`.label-row[data-label-id="${CSS.escape(id)}"]`);
      const name = row.querySelector('.label-name').value.trim();
      const color = row.querySelector('.label-color').value;
      if (!name) {
        setLabelError('Name is required');
        return;
      }
      await updateLabel(id, name, color);
    });
  });
  document.querySelectorAll('.label-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteLabel(btn.dataset.labelId);
    });
  });

  // Card: open add-label menu
  document.querySelectorAll('[data-add-label-card-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = btn.dataset.addLabelCardId;
      openLabelMenuCardId = openLabelMenuCardId === id ? null : id;
      render();
    });
  });

  // Card: toggle a label assignment from menu
  document.querySelectorAll('[data-toggle-label-id]').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const cardId = btn.dataset.toggleCardId;
      const labelId = btn.dataset.toggleLabelId;
      const isAssigned = btn.classList.contains('assigned');
      if (isAssigned) await unassignLabel(cardId, labelId);
      else await assignLabel(cardId, labelId);
    });
  });

  // Card: remove chip
  document.querySelectorAll('.chip-remove').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await unassignLabel(btn.dataset.removeCardId, btn.dataset.removeLabelId);
    });
  });
}

function setLabelError(message) {
  const el = document.querySelector('#label-error');
  if (el) el.textContent = message;
}

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
    setLabelError('');
  } catch (error) {
    setLabelError(error.message);
  }
}

async function updateLabel(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update failed');
    setLabelError('');
  } catch (error) {
    setLabelError(error.message);
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Delete failed');
    activeFilter.delete(id);
    setLabelError('');
  } catch (error) {
    setLabelError(error.message);
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
    const response = await fetch(
      `${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`,
      { method: 'DELETE' }
    );
    if (!response.ok) throw new Error((await response.json()).error || 'Unassign failed');
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
  }
}

async function loadLabels() {
  const response = await fetch(`${API_BASE}/api/labels`);
  if (!response.ok) throw new Error('Could not load labels');
  labels = await response.json();
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
    // Drop filters for labels that no longer exist.
    activeFilter = new Set([...activeFilter].filter((id) => labels.some((l) => l.id === id)));
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
    await Promise.all([loadBoard(), loadLabels()]);
    render();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
