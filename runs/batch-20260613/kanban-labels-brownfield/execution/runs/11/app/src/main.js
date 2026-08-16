import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set(); // label ids selected in the filter (client-side view state)
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelMenuCardId = null; // card id whose label dropdown is open
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
      <div class="topbar-actions">
        <button id="open-label-manager" type="button" class="ghost-btn">Manage labels</button>
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
  const chips = labels.map((label) => {
    const active = activeFilter.has(label.id);
    return `
      <button type="button" class="filter-chip${active ? ' active' : ''}" data-filter-label="${escapeHtml(label.id)}" style="--label-color:${escapeHtml(label.color)}">
        <span class="swatch" style="background:${escapeHtml(label.color)}"></span>
        ${escapeHtml(label.name)}
      </button>
    `;
  }).join('');
  return `
    <div class="filter-bar">
      <span class="filter-bar-title">Filter by label:</span>
      ${labels.length ? chips : '<span class="filter-empty">No labels yet.</span>'}
      ${activeFilter.size ? '<button type="button" id="clear-filter" class="clear-filter">Clear filter</button>' : ''}
    </div>
  `;
}

function renderLabelManager() {
  const rows = labels.map((label) => `
    <li class="label-manager-row" data-label-id="${escapeHtml(label.id)}">
      <input type="color" class="lm-color" value="${escapeHtml(normalizeColorForInput(label.color))}" />
      <input type="text" class="lm-name" value="${escapeHtml(label.name)}" maxlength="100" />
      <button type="button" class="lm-save">Save</button>
      <button type="button" class="lm-delete">Delete</button>
    </li>
  `).join('');
  return `
    <div class="modal-overlay" id="label-manager-overlay">
      <div class="modal" role="dialog" aria-label="Manage labels">
        <div class="modal-header">
          <h2>Manage labels</h2>
          <button type="button" id="close-label-manager" class="modal-close" aria-label="Close">×</button>
        </div>
        <form id="create-label-form" class="create-label-form">
          <input type="color" name="color" value="#2563eb" />
          <input type="text" name="name" placeholder="New label name…" maxlength="100" autocomplete="off" />
          <button type="submit">Create</button>
        </form>
        <ul class="label-manager-list">
          ${rows || '<li class="label-empty">No labels yet. Create one above.</li>'}
        </ul>
      </div>
    </div>
  `;
}

function normalizeColorForInput(color) {
  // <input type="color"> requires #rrggbb. Expand #rgb shorthand.
  if (/^#[0-9a-fA-F]{3}$/.test(color)) {
    return '#' + color.slice(1).split('').map((c) => c + c).join('');
  }
  return color;
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
  const chips = cardLabels.map((label) => `
    <span class="chip" style="background:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">
      <span class="chip-text">${escapeHtml(label.name)}</span>
      <button type="button" class="chip-remove" data-remove-label="${escapeHtml(label.id)}" aria-label="Remove label">×</button>
    </span>
  `).join('');

  const menuOpen = labelMenuCardId === card.id;
  const assigned = new Set(cardLabels.map((l) => l.id));
  const menu = menuOpen ? `
    <div class="label-menu">
      ${labels.length ? labels.map((label) => `
        <label class="label-menu-item">
          <input type="checkbox" data-toggle-label="${escapeHtml(label.id)}" ${assigned.has(label.id) ? 'checked' : ''} />
          <span class="swatch" style="background:${escapeHtml(label.color)}"></span>
          ${escapeHtml(label.name)}
        </label>
      `).join('') : '<div class="label-menu-empty">No labels. Create some first.</div>'}
    </div>
  ` : '';

  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${chips ? `<div class="chips">${chips}</div>` : ''}
      <div class="card-footer">
        <button type="button" class="add-label-btn" data-card-id="${escapeHtml(card.id)}">+ Label</button>
        ${menu}
      </div>
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

  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      // Don't initiate a drag when interacting with label controls.
      if (event.target.closest('.card-footer, .chips, .label-menu')) {
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
      labelMenuCardId = null;
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
  // Filter bar chips
  document.querySelectorAll('[data-filter-label]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.filterLabel;
      if (activeFilter.has(id)) activeFilter.delete(id);
      else activeFilter.add(id);
      render();
    });
  });
  const clearBtn = document.querySelector('#clear-filter');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilter.clear();
      render();
    });
  }

  // Label manager open/close
  const openManager = document.querySelector('#open-label-manager');
  if (openManager) {
    openManager.addEventListener('click', () => {
      labelManagerOpen = true;
      render();
    });
  }
  const closeManager = document.querySelector('#close-label-manager');
  if (closeManager) {
    closeManager.addEventListener('click', () => {
      labelManagerOpen = false;
      render();
    });
  }
  const overlay = document.querySelector('#label-manager-overlay');
  if (overlay) {
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        labelManagerOpen = false;
        render();
      }
    });
  }

  // Create label
  const createForm = document.querySelector('#create-label-form');
  if (createForm) {
    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
      if (!name) return;
      await createLabelReq(name, color);
    });
  }

  // Edit/delete label rows
  document.querySelectorAll('.label-manager-row').forEach((row) => {
    const id = row.dataset.labelId;
    const saveBtn = row.querySelector('.lm-save');
    const deleteBtn = row.querySelector('.lm-delete');
    saveBtn.addEventListener('click', async () => {
      const name = row.querySelector('.lm-name').value.trim();
      const color = row.querySelector('.lm-color').value;
      if (!name) return;
      await updateLabelReq(id, name, color);
    });
    deleteBtn.addEventListener('click', async () => {
      await deleteLabelReq(id);
    });
  });

  // Add-label dropdown on cards
  document.querySelectorAll('.add-label-btn').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = btn.dataset.cardId;
      labelMenuCardId = labelMenuCardId === id ? null : id;
      render();
    });
  });

  // Prevent drag from starting on interactive card controls
  document.querySelectorAll('.card-footer, .chip-remove, .label-menu').forEach((el) => {
    el.addEventListener('mousedown', (event) => event.stopPropagation());
    el.setAttribute('draggable', 'false');
  });

  // Toggle assignment checkboxes
  document.querySelectorAll('[data-toggle-label]').forEach((input) => {
    input.addEventListener('change', async () => {
      const labelId = input.dataset.toggleLabel;
      const card = input.closest('.card');
      const cardId = card?.dataset.cardId;
      if (!cardId) return;
      if (input.checked) await assignLabelReq(cardId, labelId);
      else await unassignLabelReq(cardId, labelId);
    });
  });

  // Remove-chip buttons
  document.querySelectorAll('[data-remove-label]').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const labelId = btn.dataset.removeLabel;
      const card = btn.closest('.card');
      const cardId = card?.dataset.cardId;
      if (!cardId) return;
      await unassignLabelReq(cardId, labelId);
    });
  });
}

async function createLabelReq(name, color) {
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

async function updateLabelReq(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update failed');
  } catch (error) {
    setStatus(`Label update failed: ${error.message}`, true);
  }
}

async function deleteLabelReq(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 204) throw new Error('Delete failed');
  } catch (error) {
    setStatus(`Label delete failed: ${error.message}`, true);
  }
}

async function assignLabelReq(cardId, labelId) {
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

async function unassignLabelReq(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, {
      method: 'DELETE',
    });
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
  // Keep the local label list in sync whenever the server includes it.
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

  if (Array.isArray(message.labels) && !message.card) {
    // Pure label mutation (e.g. label-create) with no board/card payload.
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

function pruneFilter() {
  // Drop filter selections for labels that no longer exist.
  const ids = new Set(labels.map((l) => l.id));
  for (const id of [...activeFilter]) {
    if (!ids.has(id)) activeFilter.delete(id);
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
    await Promise.all([loadBoard(), loadLabels()]);
    render();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
