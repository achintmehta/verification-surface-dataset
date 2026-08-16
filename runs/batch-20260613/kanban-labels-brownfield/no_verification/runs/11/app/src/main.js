import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set(); // label ids selected in the filter bar (client-side view state)
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelMenuCardId = null; // card whose label menu is open

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

// --- Labels: filtering (client-side view state only) ---

function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((label) => label.id));
  for (const id of activeFilter) {
    if (cardLabelIds.has(id)) return true; // at least one selected label present
  }
  return false;
}

function pickTextColor(hex) {
  const value = String(hex || '').replace('#', '');
  const full = value.length === 3
    ? value.split('').map((c) => c + c).join('')
    : value.padEnd(6, '0').slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
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
  `;
  bindEvents();
}

function renderFilterBar() {
  return `
    <section class="toolbar">
      <div class="filter-bar">
        <span class="filter-label">Filter:</span>
        <div class="filter-chips">
          ${labels.length === 0 ? '<span class="filter-empty">No labels yet</span>' : labels.map(renderFilterChip).join('')}
        </div>
        ${activeFilter.size > 0 ? '<button type="button" class="clear-filter" data-action="clear-filter">Clear filter</button>' : ''}
      </div>
      <button type="button" class="manage-labels" data-action="open-label-manager">Manage labels</button>
    </section>
  `;
}

function renderFilterChip(label) {
  const active = activeFilter.has(label.id);
  return `
    <button
      type="button"
      class="chip filter-chip${active ? ' active' : ''}"
      data-action="toggle-filter"
      data-label-id="${escapeHtml(label.id)}"
      style="background:${escapeHtml(label.color)};color:${escapeHtml(pickTextColor(label.color))}"
      aria-pressed="${active}"
    >${escapeHtml(label.name)}</button>
  `;
}

function renderColumn(column) {
  const visibleCards = column.cards.filter(cardMatchesFilter);
  const hiddenCount = column.cards.length - visibleCards.length;
  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${visibleCards.map(renderCard).join('')}
        ${hiddenCount > 0 ? `<div class="hidden-note">${hiddenCount} card${hiddenCount === 1 ? '' : 's'} hidden by filter</div>` : ''}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const cardLabels = card.labels || [];
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      ${cardLabels.length ? `<div class="card-labels">${cardLabels.map(renderCardChip).join('')}</div>` : ''}
      <div class="card-text">${escapeHtml(card.text)}</div>
      <button type="button" class="card-label-btn" data-action="open-card-labels" data-card-id="${escapeHtml(card.id)}" title="Edit labels">🏷</button>
      ${labelMenuCardId === card.id ? renderCardLabelMenu(card) : ''}
    </article>
  `;
}

function renderCardChip(label) {
  return `<span class="chip card-chip" style="background:${escapeHtml(label.color)};color:${escapeHtml(pickTextColor(label.color))}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`;
}

function renderCardLabelMenu(card) {
  const assigned = new Set((card.labels || []).map((label) => label.id));
  return `
    <div class="card-label-menu" data-card-id="${escapeHtml(card.id)}">
      <div class="card-label-menu-title">Labels</div>
      ${labels.length === 0 ? '<div class="card-label-menu-empty">No labels. Use “Manage labels”.</div>' : labels.map((label) => `
        <label class="card-label-option">
          <input
            type="checkbox"
            data-action="toggle-card-label"
            data-card-id="${escapeHtml(card.id)}"
            data-label-id="${escapeHtml(label.id)}"
            ${assigned.has(label.id) ? 'checked' : ''}
          />
          <span class="chip card-chip" style="background:${escapeHtml(label.color)};color:${escapeHtml(pickTextColor(label.color))}">${escapeHtml(label.name)}</span>
        </label>
      `).join('')}
      <button type="button" class="card-label-menu-close" data-action="close-card-labels">Close</button>
    </div>
  `;
}

function renderLabelManager() {
  if (!labelManagerOpen) return '';
  return `
    <div class="modal-backdrop" data-action="close-label-manager-backdrop">
      <div class="modal" role="dialog" aria-label="Manage labels">
        <div class="modal-header">
          <h3>Manage labels</h3>
          <button type="button" class="modal-close" data-action="close-label-manager">✕</button>
        </div>
        <ul class="label-list">
          ${labels.length === 0 ? '<li class="label-list-empty">No labels yet.</li>' : labels.map(renderLabelRow).join('')}
        </ul>
        <form class="label-create" data-action="create-label">
          <input name="name" type="text" maxlength="100" placeholder="New label name…" autocomplete="off" />
          <input name="color" type="color" value="#2563eb" />
          <button type="submit">Add label</button>
        </form>
        <div class="label-error" id="label-error"></div>
      </div>
    </div>
  `;
}

function renderLabelRow(label) {
  return `
    <li class="label-row" data-label-id="${escapeHtml(label.id)}">
      <input class="label-name-input" data-action="rename-label" data-label-id="${escapeHtml(label.id)}" type="text" maxlength="100" value="${escapeHtml(label.name)}" />
      <input class="label-color-input" data-action="recolor-label" data-label-id="${escapeHtml(label.id)}" type="color" value="${escapeHtml(normalizeHex(label.color))}" />
      <span class="chip card-chip" style="background:${escapeHtml(label.color)};color:${escapeHtml(pickTextColor(label.color))}">${escapeHtml(label.name)}</span>
      <button type="button" class="label-delete" data-action="delete-label" data-label-id="${escapeHtml(label.id)}" title="Delete label">Delete</button>
    </li>
  `;
}

function normalizeHex(hex) {
  const value = String(hex || '').replace('#', '');
  if (value.length === 3) return '#' + value.split('').map((c) => c + c).join('');
  if (value.length === 6) return '#' + value;
  return '#2563eb';
}

let labelManagerOpen = false;

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
        /* some browsers require this in try/catch */
      }
    });
    cardEl.addEventListener('dragend', () => {
      draggedCardId = null;
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.cards.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      list.classList.add('drop-target');
    });
    list.addEventListener('dragleave', () => {
      list.classList.remove('drop-target');
    });
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
      if (!cardId) return;
      const columnId = list.dataset.columnId;
      const target = resolveDropTarget(list, event.clientY, cardId);
      optimisticMove(cardId, columnId, target.beforeId, target.afterId);
      render();
      await moveCard(cardId, columnId, target.beforeId, target.afterId);
    });
  });

  // --- Labels: filter bar ---
  document.querySelectorAll('[data-action="toggle-filter"]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.labelId;
      if (activeFilter.has(id)) activeFilter.delete(id);
      else activeFilter.add(id);
      render();
    });
  });
  const clearFilterBtn = document.querySelector('[data-action="clear-filter"]');
  if (clearFilterBtn) {
    clearFilterBtn.addEventListener('click', () => {
      activeFilter.clear();
      render();
    });
  }

  // --- Labels: per-card menu ---
  document.querySelectorAll('[data-action="open-card-labels"]').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = el.dataset.cardId;
      labelMenuCardId = labelMenuCardId === id ? null : id;
      render();
    });
  });
  document.querySelectorAll('[data-action="close-card-labels"]').forEach((el) => {
    el.addEventListener('click', () => {
      labelMenuCardId = null;
      render();
    });
  });
  document.querySelectorAll('[data-action="toggle-card-label"]').forEach((el) => {
    el.addEventListener('change', async () => {
      const cardId = el.dataset.cardId;
      const labelId = el.dataset.labelId;
      if (el.checked) await assignCardLabel(cardId, labelId);
      else await unassignCardLabel(cardId, labelId);
    });
  });

  // --- Labels: manager ---
  const openManager = document.querySelector('[data-action="open-label-manager"]');
  if (openManager) {
    openManager.addEventListener('click', () => {
      labelManagerOpen = true;
      render();
    });
  }
  document.querySelectorAll('[data-action="close-label-manager"]').forEach((el) => {
    el.addEventListener('click', () => {
      labelManagerOpen = false;
      render();
    });
  });
  const backdrop = document.querySelector('[data-action="close-label-manager-backdrop"]');
  if (backdrop) {
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) {
        labelManagerOpen = false;
        render();
      }
    });
  }
  const createForm = document.querySelector('[data-action="create-label"]');
  if (createForm) {
    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
      if (!name) {
        setLabelError('Name is required.');
        return;
      }
      const ok = await createLabel(name, color);
      if (ok) createForm.elements.name.value = '';
    });
  }
  document.querySelectorAll('[data-action="rename-label"]').forEach((el) => {
    const commit = async () => {
      const id = el.dataset.labelId;
      const label = labels.find((l) => l.id === id);
      const name = el.value.trim();
      if (!label || name === label.name) return;
      if (!name) {
        el.value = label.name;
        setLabelError('Name is required.');
        return;
      }
      await updateLabel(id, { name });
    };
    el.addEventListener('blur', commit);
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        el.blur();
      }
    });
  });
  document.querySelectorAll('[data-action="recolor-label"]').forEach((el) => {
    el.addEventListener('change', async () => {
      const id = el.dataset.labelId;
      await updateLabel(id, { color: el.value });
    });
  });
  document.querySelectorAll('[data-action="delete-label"]').forEach((el) => {
    el.addEventListener('click', async () => {
      const id = el.dataset.labelId;
      await deleteLabel(id);
    });
  });
}

function setLabelError(message) {
  const el = document.querySelector('#label-error');
  if (el) el.textContent = message || '';
}

function resolveDropTarget(list, clientY, cardId) {
  const ids = [...list.querySelectorAll('.card')]
    .filter((el) => el.dataset.cardId !== cardId)
    .map((el) => ({ id: el.dataset.cardId, rect: el.getBoundingClientRect() }));

  let beforeId = null;
  for (const item of ids) {
    const midpoint = item.rect.top + item.rect.height / 2;
    if (clientY < midpoint) {
      beforeId = item.id;
      break;
    }
  }

  if (beforeId) {
    const index = ids.findIndex((item) => item.id === beforeId);
    const afterId = index > 0 ? ids[index - 1].id : null;
    return { beforeId, afterId };
  }

  const afterId = ids.length ? ids[ids.length - 1].id : null;
  return { beforeId: null, afterId };
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

// --- Labels: API calls ---

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
      const message = (await response.json().catch(() => ({}))).error || 'Create label failed';
      setLabelError(message);
      return false;
    }
    setLabelError('');
    return true;
  } catch (error) {
    setLabelError(error.message);
    return false;
  }
}

async function updateLabel(id, { name, color }) {
  try {
    const body = {};
    if (name !== undefined) body.name = name;
    if (color !== undefined) body.color = color;
    const response = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const message = (await response.json().catch(() => ({}))).error || 'Update label failed';
      setLabelError(message);
      return false;
    }
    setLabelError('');
    return true;
  } catch (error) {
    setLabelError(error.message);
    return false;
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 204) {
      const message = (await response.json().catch(() => ({}))).error || 'Delete label failed';
      setLabelError(message);
      return;
    }
    activeFilter.delete(id);
    setLabelError('');
  } catch (error) {
    setLabelError(error.message);
  }
}

async function assignCardLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Assign failed');
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
  }
}

async function unassignCardLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Unassign failed');
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
  }
}

function applyMutation(message) {
  // Label mutations always carry an updated labels list; keep our cache fresh.
  if (Array.isArray(message.labels)) {
    labels = message.labels;
  }

  if (message.board) {
    board = normalizeBoard(message.board);
    // Drop any filter selections for labels that no longer exist.
    pruneFilter();
    render();
    setStatus('Synced');
    return;
  }

  if (!message.card) {
    pruneFilter();
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

function pruneFilter() {
  const existing = new Set(labels.map((label) => label.id));
  for (const id of [...activeFilter]) {
    if (!existing.has(id)) activeFilter.delete(id);
  }
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
    await loadLabels();
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
