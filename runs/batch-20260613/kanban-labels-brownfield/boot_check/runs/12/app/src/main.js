import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [], labels: [] };
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

// Client-side view state (never sent to the server).
let activeFilter = new Set(); // selected label ids to filter by
let labelMenuCardId = null; // card whose label menu is currently open

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
  return { columns, labels: [...(nextBoard.labels || [])] };
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  const labels = card.labels || [];
  return labels.some((label) => activeFilter.has(label.id));
}

function contrastColor(hex) {
  let value = String(hex || '').trim().replace('#', '');
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  if (value.length !== 6) return '#ffffff';
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#172033' : '#ffffff';
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
    ${labelMenuCardId ? renderLabelMenu(labelMenuCardId) : ''}
  `;
  bindEvents();
}

function renderFilterBar() {
  const labels = board.labels || [];
  const chips = labels
    .map((label) => {
      const active = activeFilter.has(label.id);
      return `
        <button type="button"
          class="filter-chip${active ? ' active' : ''}"
          data-filter-label-id="${escapeHtml(label.id)}"
          style="--chip-color:${escapeHtml(label.color)};--chip-text:${contrastColor(label.color)}"
          aria-pressed="${active}">
          ${escapeHtml(label.name)}
        </button>`;
    })
    .join('');
  return `
    <section class="filterbar">
      <div class="filterbar-left">
        <span class="filterbar-title">Filter:</span>
        ${chips || '<span class="filterbar-empty">No labels yet</span>'}
        ${activeFilter.size > 0 ? '<button type="button" class="filter-clear" id="filter-clear">Clear filter</button>' : ''}
      </div>
      <button type="button" class="manage-labels-btn" id="open-label-manager">Manage labels</button>
    </section>
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
  const labels = card.labels || [];
  const chips = labels
    .map(
      (label) => `
        <span class="label-chip" style="--chip-color:${escapeHtml(label.color)};--chip-text:${contrastColor(label.color)}" title="${escapeHtml(label.name)}">
          ${escapeHtml(label.name)}
        </span>`
    )
    .join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${chips ? `<div class="card-labels">${chips}</div>` : ''}
      <button type="button" class="card-label-btn" data-card-label-btn="${escapeHtml(card.id)}" title="Edit labels">🏷 Labels</button>
    </article>
  `;
}

function renderLabelManager() {
  if (!labelManagerOpen) return '';
  const labels = board.labels || [];
  const rows = labels
    .map(
      (label) => `
      <li class="label-row" data-label-row="${escapeHtml(label.id)}">
        <input type="color" class="label-color-input" data-label-color="${escapeHtml(label.id)}" value="${escapeHtml(toColorInputValue(label.color))}" />
        <input type="text" class="label-name-input" data-label-name="${escapeHtml(label.id)}" value="${escapeHtml(label.name)}" maxlength="60" />
        <button type="button" class="label-save-btn" data-label-save="${escapeHtml(label.id)}">Save</button>
        <button type="button" class="label-delete-btn" data-label-delete="${escapeHtml(label.id)}">Delete</button>
      </li>`
    )
    .join('');
  return `
    <div class="modal-backdrop" id="label-manager-backdrop">
      <div class="modal" role="dialog" aria-label="Manage labels">
        <div class="modal-header">
          <h3>Manage labels</h3>
          <button type="button" class="modal-close" id="close-label-manager">✕</button>
        </div>
        <form class="label-create-form" id="label-create-form">
          <input type="color" id="new-label-color" value="#2563eb" />
          <input type="text" id="new-label-name" placeholder="New label name" maxlength="60" autocomplete="off" />
          <button type="submit">Add label</button>
        </form>
        <ul class="label-list">
          ${rows || '<li class="label-list-empty">No labels yet. Create one above.</li>'}
        </ul>
        <div class="modal-error" id="label-manager-error"></div>
      </div>
    </div>
  `;
}

function renderLabelMenu(cardId) {
  const found = findCard(cardId);
  if (!found) return '';
  const assigned = new Set((found.card.labels || []).map((l) => l.id));
  const labels = board.labels || [];
  const rows = labels
    .map(
      (label) => `
        <label class="label-menu-row">
          <input type="checkbox" data-assign-label="${escapeHtml(label.id)}" ${assigned.has(label.id) ? 'checked' : ''} />
          <span class="label-chip" style="--chip-color:${escapeHtml(label.color)};--chip-text:${contrastColor(label.color)}">${escapeHtml(label.name)}</span>
        </label>`
    )
    .join('');
  return `
    <div class="modal-backdrop" id="label-menu-backdrop">
      <div class="modal" role="dialog" aria-label="Card labels">
        <div class="modal-header">
          <h3>Card labels</h3>
          <button type="button" class="modal-close" id="close-label-menu">✕</button>
        </div>
        <div class="label-menu-list">
          ${rows || '<div class="label-list-empty">No labels yet. Create one in “Manage labels”.</div>'}
        </div>
      </div>
    </div>
  `;
}

let labelManagerOpen = false;

function toColorInputValue(color) {
  let value = String(color || '').trim();
  if (!value.startsWith('#')) value = '#' + value;
  const hex = value.replace('#', '');
  if (hex.length === 3) return '#' + hex.split('').map((c) => c + c).join('');
  if (hex.length === 6) return '#' + hex;
  return '#000000';
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

  bindLabelEvents();
}

function bindLabelEvents() {
  // Filter bar
  document.querySelectorAll('[data-filter-label-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.filterLabelId;
      if (activeFilter.has(id)) activeFilter.delete(id);
      else activeFilter.add(id);
      render();
    });
  });
  const clearBtn = document.querySelector('#filter-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilter.clear();
      render();
    });
  }

  // Open managers
  const openManager = document.querySelector('#open-label-manager');
  if (openManager) {
    openManager.addEventListener('click', () => {
      labelManagerOpen = true;
      render();
    });
  }

  // Per-card label button
  document.querySelectorAll('[data-card-label-btn]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      labelMenuCardId = btn.dataset.cardLabelBtn;
      render();
    });
  });

  bindLabelManagerEvents();
  bindLabelMenuEvents();
}

function bindLabelManagerEvents() {
  const backdrop = document.querySelector('#label-manager-backdrop');
  if (!backdrop) return;

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) {
      labelManagerOpen = false;
      render();
    }
  });
  document.querySelector('#close-label-manager')?.addEventListener('click', () => {
    labelManagerOpen = false;
    render();
  });

  const createForm = document.querySelector('#label-create-form');
  createForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = document.querySelector('#new-label-name').value.trim();
    const color = document.querySelector('#new-label-color').value;
    if (!name) {
      showManagerError('Label name cannot be empty');
      return;
    }
    await createLabel(name, color);
  });

  document.querySelectorAll('[data-label-save]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.labelSave;
      const name = document.querySelector(`[data-label-name="${cssEscape(id)}"]`).value.trim();
      const color = document.querySelector(`[data-label-color="${cssEscape(id)}"]`).value;
      if (!name) {
        showManagerError('Label name cannot be empty');
        return;
      }
      await updateLabel(id, name, color);
    });
  });

  document.querySelectorAll('[data-label-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteLabel(btn.dataset.labelDelete);
    });
  });
}

function bindLabelMenuEvents() {
  const backdrop = document.querySelector('#label-menu-backdrop');
  if (!backdrop) return;

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) {
      labelMenuCardId = null;
      render();
    }
  });
  document.querySelector('#close-label-menu')?.addEventListener('click', () => {
    labelMenuCardId = null;
    render();
  });

  document.querySelectorAll('[data-assign-label]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const labelId = checkbox.dataset.assignLabel;
      const cardId = labelMenuCardId;
      if (!cardId) return;
      if (checkbox.checked) await assignLabel(cardId, labelId);
      else await unassignLabel(cardId, labelId);
    });
  });
}

function showManagerError(message) {
  const el = document.querySelector('#label-manager-error');
  if (el) el.textContent = message;
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
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

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) {
      const message = (await response.json()).error || 'Create label failed';
      showManagerError(message);
      return;
    }
    const nameInput = document.querySelector('#new-label-name');
    if (nameInput) nameInput.value = '';
    showManagerError('');
  } catch (error) {
    showManagerError(`Create label failed: ${error.message}`);
  }
}

async function updateLabel(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) {
      const message = (await response.json()).error || 'Update label failed';
      showManagerError(message);
      return;
    }
    showManagerError('');
  } catch (error) {
    showManagerError(`Update label failed: ${error.message}`);
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Delete label failed');
    activeFilter.delete(id);
  } catch (error) {
    showManagerError(`Delete label failed: ${error.message}`);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Assign label failed');
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
    if (!response.ok) throw new Error((await response.json()).error || 'Unassign label failed');
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
  }
}

function pruneFilter() {
  const valid = new Set((board.labels || []).map((l) => l.id));
  for (const id of [...activeFilter]) {
    if (!valid.has(id)) activeFilter.delete(id);
  }
}

function applyMutation(message) {
  if (message.board) {
    board = normalizeBoard(message.board);
    pruneFilter();
    render();
    setStatus('Synced');
    return;
  }

  if (!message.card) return;
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
