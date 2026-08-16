import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set(); // label ids selected in the filter bar (client-side view state)
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelManagerOpen = false;
let openCardMenuId = null; // card id whose label menu is open

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
  const cardLabelIds = new Set((card.labels || []).map((label) => label.id));
  for (const labelId of activeFilter) {
    if (cardLabelIds.has(labelId)) return true;
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
      <div class="topbar-actions">
        <button type="button" id="manage-labels" class="ghost-btn">Manage labels</button>
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
  if (labels.length === 0) {
    return '<div class="filter-bar empty">No labels yet — create one with “Manage labels”.</div>';
  }
  return `
    <div class="filter-bar">
      <span class="filter-bar__label">Filter:</span>
      <div class="filter-chips">
        ${labels
          .map((label) => {
            const active = activeFilter.has(label.id);
            return `
              <button
                type="button"
                class="filter-chip${active ? ' active' : ''}"
                data-filter-label-id="${escapeHtml(label.id)}"
                style="--chip-color: ${escapeHtml(label.color)}"
              >
                <span class="chip-dot"></span>${escapeHtml(label.name)}
              </button>`;
          })
          .join('')}
      </div>
      <button type="button" id="clear-filter" class="ghost-btn" ${activeFilter.size === 0 ? 'disabled' : ''}>Clear</button>
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
        <span class="label-chip" style="--chip-color: ${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">
          <span class="chip-dot"></span>${escapeHtml(label.name)}
          <button type="button" class="chip-remove" data-remove-label="${escapeHtml(label.id)}" data-card-id="${escapeHtml(card.id)}" title="Remove label">×</button>
        </span>`
    )
    .join('');
  const menuOpen = openCardMenuId === card.id;
  const assignedIds = new Set(cardLabels.map((label) => label.id));
  const menu = menuOpen
    ? `
      <div class="label-menu">
        ${
          labels.length === 0
            ? '<div class="label-menu__empty">No labels yet.</div>'
            : labels
                .map(
                  (label) => `
            <label class="label-menu__item">
              <input type="checkbox" data-toggle-label="${escapeHtml(label.id)}" data-card-id="${escapeHtml(card.id)}" ${assignedIds.has(label.id) ? 'checked' : ''} />
              <span class="chip-dot" style="--chip-color: ${escapeHtml(label.color)}"></span>
              ${escapeHtml(label.name)}
            </label>`
                )
                .join('')
        }
      </div>`
    : '';
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${chips ? `<div class="card-labels">${chips}</div>` : ''}
      <div class="card-footer">
        <button type="button" class="card-label-btn" data-label-menu="${escapeHtml(card.id)}">＋ Labels</button>
      </div>
      ${menu}
    </article>
  `;
}

function renderLabelManager() {
  return `
    <div class="modal-overlay" id="label-manager-overlay">
      <div class="modal" role="dialog" aria-label="Manage labels">
        <div class="modal-header">
          <h3>Labels</h3>
          <button type="button" class="modal-close" id="close-label-manager" title="Close">×</button>
        </div>
        <div class="modal-body">
          <ul class="label-list">
            ${
              labels.length === 0
                ? '<li class="label-list__empty">No labels yet.</li>'
                : labels
                    .map(
                      (label) => `
              <li class="label-list__item" data-label-row="${escapeHtml(label.id)}">
                <input class="label-color-input" type="color" value="${escapeHtml(normalizeHex(label.color))}" data-edit-color="${escapeHtml(label.id)}" />
                <input class="label-name-input" type="text" maxlength="100" value="${escapeHtml(label.name)}" data-edit-name="${escapeHtml(label.id)}" />
                <button type="button" class="ghost-btn" data-save-label="${escapeHtml(label.id)}">Save</button>
                <button type="button" class="danger-btn" data-delete-label="${escapeHtml(label.id)}">Delete</button>
              </li>`
                    )
                    .join('')
            }
          </ul>
          <form class="label-create" id="create-label-form">
            <input class="label-color-input" type="color" name="color" value="#2563eb" />
            <input class="label-name-input" type="text" name="name" maxlength="100" placeholder="New label name…" autocomplete="off" />
            <button type="submit">Add label</button>
          </form>
          <div class="modal-error" id="label-error"></div>
        </div>
      </div>
    </div>
  `;
}

function normalizeHex(color) {
  if (typeof color !== 'string') return '#2563eb';
  const value = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    return ('#' + value.slice(1).split('').map((c) => c + c).join('')).toLowerCase();
  }
  return '#2563eb';
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
      try {
        event.dataTransfer.setData('text/plain', draggedCardId);
      } catch {
        /* ignore */
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
      const referenceId = getDropReference(list, event.clientY, cardId);
      placeCardInDom(list, cardId, referenceId);
      const { afterId, beforeId } = computeNeighbors(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
      await moveCard(cardId, columnId, beforeId, afterId);
    });
  });

  // Label filter bar
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

  // Label menu open/close on cards
  document.querySelectorAll('[data-label-menu]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = btn.dataset.labelMenu;
      openCardMenuId = openCardMenuId === id ? null : id;
      render();
    });
  });
  document.querySelectorAll('[data-toggle-label]').forEach((input) => {
    input.addEventListener('change', async () => {
      const cardId = input.dataset.cardId;
      const labelId = input.dataset.toggleLabel;
      if (input.checked) await assignLabel(cardId, labelId);
      else await unassignLabel(cardId, labelId);
    });
  });
  document.querySelectorAll('[data-remove-label]').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await unassignLabel(btn.dataset.cardId, btn.dataset.removeLabel);
    });
  });

  // Label manager
  document.querySelector('#manage-labels')?.addEventListener('click', () => {
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
  document.querySelector('#create-label-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) {
      setLabelError('Label name is required');
      return;
    }
    await createLabel(name, color);
  });
  document.querySelectorAll('[data-save-label]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.saveLabel;
      const name = document.querySelector(`[data-edit-name="${CSS.escape(id)}"]`)?.value.trim();
      const color = document.querySelector(`[data-edit-color="${CSS.escape(id)}"]`)?.value;
      await updateLabel(id, name, color);
    });
  });
  document.querySelectorAll('[data-delete-label]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteLabel(btn.dataset.deleteLabel);
    });
  });
}

function getDropReference(list, clientY, draggingId) {
  const cards = [...list.querySelectorAll('.card')].filter((el) => el.dataset.cardId !== draggingId);
  for (const el of cards) {
    const rect = el.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return el;
  }
  return null;
}

function placeCardInDom(list, cardId, referenceEl) {
  const cardEl = document.querySelector(`.card[data-card-id="${CSS.escape(cardId)}"]`);
  if (!cardEl) return;
  if (referenceEl) list.insertBefore(cardEl, referenceEl);
  else list.appendChild(cardEl);
}

function computeNeighbors(list, cardId) {
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
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
    setLabelError('');
  } catch (error) {
    setLabelError(error.message);
  }
}

async function updateLabel(id, name, color) {
  try {
    if (!name) throw new Error('Label name is required');
    const response = await fetch(`${API_BASE}/api/labels/${id}`, {
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
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Delete failed');
    activeFilter.delete(id);
    setLabelError('');
  } catch (error) {
    setLabelError(error.message);
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
    setStatus(`Assign failed: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Unassign failed');
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
  }
}

function setLabelError(message) {
  const el = document.querySelector('#label-error');
  if (el) el.textContent = message || '';
}

function applyMutation(message) {
  if (message.board) {
    board = normalizeBoard(message.board);
  }
  // Label list changes that don't necessarily affect assignments still need a refresh.
  if (
    message.type === 'label-create' ||
    message.type === 'label-update' ||
    message.type === 'label-delete'
  ) {
    if (message.type === 'label-delete') {
      activeFilter.delete(message.labelId);
    }
    refreshLabels().then(() => {
      render();
      setStatus('Synced');
    });
    return;
  }

  if (message.board) {
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

async function refreshLabels() {
  try {
    const response = await fetch(`${API_BASE}/api/labels`);
    if (!response.ok) throw new Error('Could not load labels');
    labels = await response.json();
    // Drop filter selections that no longer exist.
    const ids = new Set(labels.map((label) => label.id));
    for (const id of [...activeFilter]) {
      if (!ids.has(id)) activeFilter.delete(id);
    }
  } catch {
    /* keep previous labels on failure */
  }
}

async function loadBoard() {
  const [boardResponse] = await Promise.all([fetch(`${API_BASE}/api/board`), refreshLabels()]);
  if (!boardResponse.ok) throw new Error('Could not load board');
  board = normalizeBoard(await boardResponse.json());
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
