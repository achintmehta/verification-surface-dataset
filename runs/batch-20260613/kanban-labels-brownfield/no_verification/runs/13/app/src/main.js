import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set(); // label ids selected in the filter bar (client-side view state)
let labelManagerOpen = false;
let openCardMenuId = null; // card id whose label menu is open
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
        <button type="button" id="open-label-manager" class="ghost-btn">Manage labels</button>
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
  bindLabelEvents();
}

function renderFilterBar() {
  if (labels.length === 0) {
    return `<div class="filter-bar"><span class="filter-label">No labels yet — use “Manage labels” to create one.</span></div>`;
  }
  const chips = labels
    .map((label) => {
      const selected = activeFilter.has(label.id);
      return `
        <button type="button"
          class="filter-chip${selected ? ' selected' : ''}"
          data-filter-label-id="${escapeHtml(label.id)}"
          style="--chip-color: ${escapeHtml(label.color)};">
          <span class="chip-dot" style="background:${escapeHtml(label.color)}"></span>
          ${escapeHtml(label.name)}
        </button>`;
    })
    .join('');
  return `
    <div class="filter-bar">
      <span class="filter-label">Filter:</span>
      ${chips}
      ${activeFilter.size > 0 ? `<button type="button" id="clear-filter" class="ghost-btn small">Clear filter</button>` : ''}
    </div>
  `;
}

function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  const cardLabels = card.labels || [];
  return cardLabels.some((label) => activeFilter.has(label.id));
}

function renderLabelManager() {
  const rows = labels
    .map(
      (label) => `
      <div class="label-row" data-label-id="${escapeHtml(label.id)}">
        <input type="color" class="label-color-input" value="${escapeHtml(toColorInputValue(label.color))}" data-label-id="${escapeHtml(label.id)}" title="Recolor" />
        <input type="text" class="label-name-input" value="${escapeHtml(label.name)}" data-label-id="${escapeHtml(label.id)}" maxlength="60" />
        <button type="button" class="label-save-btn ghost-btn small" data-label-id="${escapeHtml(label.id)}">Save</button>
        <button type="button" class="label-delete-btn danger-btn small" data-label-id="${escapeHtml(label.id)}">Delete</button>
      </div>`
    )
    .join('');
  return `
    <div class="modal-overlay" id="label-manager-overlay">
      <div class="modal" role="dialog" aria-label="Manage labels">
        <div class="modal-header">
          <h2>Manage labels</h2>
          <button type="button" id="close-label-manager" class="ghost-btn small">Close</button>
        </div>
        <div class="label-list">
          ${rows || '<p class="muted">No labels yet.</p>'}
        </div>
        <form id="create-label-form" class="create-label">
          <input type="color" id="new-label-color" value="#2563eb" title="Color" />
          <input type="text" id="new-label-name" placeholder="New label name" maxlength="60" autocomplete="off" />
          <button type="submit">Add label</button>
        </form>
        <p class="label-error" id="label-error"></p>
      </div>
    </div>
  `;
}

function toColorInputValue(color) {
  // <input type="color"> requires 6-digit hex. Expand #abc -> #aabbcc.
  if (typeof color !== 'string') return '#000000';
  const m = /^#([0-9a-fA-F]{3})$/.exec(color.trim());
  if (m) {
    const [r, g, b] = m[1].split('');
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return /^#[0-9a-fA-F]{6}$/.test(color.trim()) ? color.trim() : '#000000';
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
  const chips = cardLabels
    .map(
      (label) => `
        <span class="card-chip" style="background:${escapeHtml(label.color)}; color:${chipTextColor(label.color)};" title="${escapeHtml(label.name)}">
          ${escapeHtml(label.name)}
          <button type="button" class="chip-remove" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}" title="Remove label" aria-label="Remove label">×</button>
        </span>`
    )
    .join('');
  const menuOpen = openCardMenuId === card.id;
  const assignedIds = new Set(cardLabels.map((l) => l.id));
  const menu = menuOpen
    ? `
      <div class="card-label-menu" data-card-id="${escapeHtml(card.id)}">
        ${
          labels.length === 0
            ? '<span class="muted">No labels. Create some in “Manage labels”.</span>'
            : labels
                .map(
                  (label) => `
                  <label class="card-label-option">
                    <input type="checkbox" class="assign-checkbox" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}" ${assignedIds.has(label.id) ? 'checked' : ''} />
                    <span class="chip-dot" style="background:${escapeHtml(label.color)}"></span>
                    ${escapeHtml(label.name)}
                  </label>`
                )
                .join('')
        }
      </div>`
    : '';
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-body">${escapeHtml(card.text)}</div>
      ${cardLabels.length ? `<div class="card-chips">${chips}</div>` : ''}
      <div class="card-footer">
        <button type="button" class="card-labels-toggle ghost-btn small" data-card-id="${escapeHtml(card.id)}">Labels</button>
      </div>
      ${menu}
    </article>
  `;
}

function chipTextColor(hex) {
  const full = toColorInputValue(hex);
  const r = parseInt(full.slice(1, 3), 16);
  const g = parseInt(full.slice(3, 5), 16);
  const b = parseInt(full.slice(5, 7), 16);
  // Relative luminance; pick black or white text for contrast.
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#172033' : '#ffffff';
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

function bindLabelEvents() {
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

  // Label manager create
  document.querySelector('#create-label-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = document.querySelector('#new-label-name').value;
    const color = document.querySelector('#new-label-color').value;
    await createLabel(name, color);
  });

  // Label manager rename/recolor/delete
  document.querySelectorAll('.label-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.labelId;
      const row = document.querySelector(`.label-row[data-label-id="${cssEscape(id)}"]`);
      if (!row) return;
      const name = row.querySelector('.label-name-input').value;
      const color = row.querySelector('.label-color-input').value;
      await updateLabel(id, name, color);
    });
  });
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteLabel(btn.dataset.labelId);
    });
  });

  // Card label menu toggle
  document.querySelectorAll('.card-labels-toggle').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = btn.dataset.cardId;
      openCardMenuId = openCardMenuId === id ? null : id;
      render();
    });
  });

  // Assign / unassign via checkboxes
  document.querySelectorAll('.assign-checkbox').forEach((box) => {
    box.addEventListener('change', async () => {
      const cardId = box.dataset.cardId;
      const labelId = box.dataset.labelId;
      if (box.checked) await assignLabel(cardId, labelId);
      else await unassignLabel(cardId, labelId);
    });
  });

  // Remove chip directly
  document.querySelectorAll('.chip-remove').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await unassignLabel(btn.dataset.cardId, btn.dataset.labelId);
    });
  });

  // Prevent the open menu's inner clicks from being treated as drag/move noise
  document.querySelectorAll('.card-label-menu, .card-footer').forEach((el) => {
    el.addEventListener('mousedown', (event) => event.stopPropagation());
  });
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\\]\[]/g, '\\$&');
}

function showLabelError(message) {
  const el = document.querySelector('#label-error');
  if (el) el.textContent = message || '';
  if (message) setStatus(message, true);
}

async function loadLabels() {
  const response = await fetch(`${API_BASE}/api/labels`);
  if (!response.ok) throw new Error('Could not load labels');
  labels = await response.json();
}

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Create label failed');
    }
    const input = document.querySelector('#new-label-name');
    if (input) input.value = '';
    showLabelError('');
  } catch (error) {
    showLabelError(error.message);
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
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Update label failed');
    }
    showLabelError('');
  } catch (error) {
    showLabelError(error.message);
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 204) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Delete label failed');
    }
    activeFilter.delete(id);
    showLabelError('');
  } catch (error) {
    showLabelError(error.message);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Assign failed');
    }
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(
      `${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`,
      { method: 'DELETE' }
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Unassign failed');
    }
  } catch (error) {
    setStatus(error.message, true);
  }
}

function applyMutation(message) {
  let labelsChanged = false;
  if (message.labels) {
    labels = message.labels;
    labelsChanged = true;
    // Drop any filter entries for labels that no longer exist.
    const existing = new Set(labels.map((l) => l.id));
    for (const id of [...activeFilter]) if (!existing.has(id)) activeFilter.delete(id);
  }

  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (!message.card) {
    if (labelsChanged) {
      render();
      setStatus('Synced');
    }
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
    loadLabels(),
  ]);
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
