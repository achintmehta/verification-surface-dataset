import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [], labels: [] };
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let activeFilter = new Set();
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
        .map((card) => ({ ...card, labels: card.labels || [] }))
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  const labels = [...(nextBoard.labels || [])].sort(
    (a, b) => String(a.name).localeCompare(String(b.name)) || a.id.localeCompare(b.id)
  );
  return { columns, labels };
}

function pruneFilter() {
  const ids = new Set((board.labels || []).map((l) => l.id));
  for (const id of [...activeFilter]) {
    if (!ids.has(id)) activeFilter.delete(id);
  }
}

function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  return (card.labels || []).some((label) => activeFilter.has(label.id));
}

function readableTextColor(hex) {
  let c = hex.replace('#', '');
  if (c.length === 3) c = c.split('').map((ch) => ch + ch).join('');
  const r = parseInt(c.slice(0, 2), 16) || 0;
  const g = parseInt(c.slice(2, 4), 16) || 0;
  const b = parseInt(c.slice(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#172033' : '#ffffff';
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function render() {
  pruneFilter();
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
  const labels = board.labels || [];
  const chips = labels.length
    ? labels
        .map((label) => {
          const active = activeFilter.has(label.id);
          const bg = active ? label.color : 'transparent';
          const fg = active ? readableTextColor(label.color) : '#172033';
          return `
            <button type="button" class="filter-chip${active ? ' active' : ''}" data-filter-label="${escapeHtml(label.id)}"
              style="--chip:${escapeHtml(label.color)};background:${escapeHtml(bg)};color:${escapeHtml(fg)};border-color:${escapeHtml(label.color)}">
              ${escapeHtml(label.name)}
            </button>`;
        })
        .join('')
    : '<span class="filter-empty">No labels yet — create one with “Manage labels”.</span>';
  return `
    <section class="filter-bar">
      <span class="filter-bar-title">Filter:</span>
      <div class="filter-chips">${chips}</div>
      ${activeFilter.size ? '<button type="button" id="clear-filter" class="ghost-btn small">Clear filter</button>' : ''}
    </section>
  `;
}

function renderLabelManager() {
  const labels = board.labels || [];
  const rows = labels.length
    ? labels
        .map(
          (label) => `
        <li class="label-row" data-label-id="${escapeHtml(label.id)}">
          <input type="color" class="label-color-input" value="${escapeHtml(label.color)}" data-action="recolor" />
          <input type="text" class="label-name-input" value="${escapeHtml(label.name)}" maxlength="60" data-action="rename" />
          <button type="button" class="danger-btn small" data-action="delete-label">Delete</button>
        </li>`
        )
        .join('')
    : '<li class="label-empty">No labels yet.</li>';
  return `
    <div class="modal-overlay" id="label-modal-overlay">
      <div class="modal" role="dialog" aria-label="Manage labels">
        <div class="modal-head">
          <h2>Manage labels</h2>
          <button type="button" class="ghost-btn small" id="close-label-manager">Close</button>
        </div>
        <form class="label-create" id="label-create-form">
          <input type="color" name="color" value="#2563eb" class="label-color-input" />
          <input type="text" name="name" placeholder="New label name" maxlength="60" autocomplete="off" />
          <button type="submit" class="primary-btn">Add label</button>
        </form>
        <ul class="label-list">${rows}</ul>
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

function renderChip(card, label) {
  const fg = readableTextColor(label.color);
  return `
    <span class="chip" style="background:${escapeHtml(label.color)};color:${fg}" title="${escapeHtml(label.name)}">
      ${escapeHtml(label.name)}
      <button type="button" class="chip-remove" data-remove-label="${escapeHtml(label.id)}" aria-label="Remove label">×</button>
    </span>`;
}

function renderLabelPicker(card) {
  const labels = board.labels || [];
  const assigned = new Set((card.labels || []).map((l) => l.id));
  const items = labels.length
    ? labels
        .map((label) => {
          const checked = assigned.has(label.id) ? 'checked' : '';
          return `
        <label class="picker-item">
          <input type="checkbox" data-toggle-label="${escapeHtml(label.id)}" ${checked} />
          <span class="picker-swatch" style="background:${escapeHtml(label.color)}"></span>
          <span class="picker-name">${escapeHtml(label.name)}</span>
        </label>`;
        })
        .join('')
    : '<span class="picker-empty">No labels. Use “Manage labels”.</span>';
  return `<div class="label-picker">${items}</div>`;
}

function renderCard(card) {
  const chips = (card.labels || []).map((label) => renderChip(card, label)).join('');
  const menuOpen = openLabelMenuCardId === card.id;
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-top">
        <div class="card-text">${escapeHtml(card.text)}</div>
        <button type="button" class="card-label-btn" data-label-menu="${escapeHtml(card.id)}" title="Edit labels">🏷</button>
      </div>
      ${chips ? `<div class="chips">${chips}</div>` : ''}
      ${menuOpen ? renderLabelPicker(card) : ''}
    </article>
  `;
}

function bindEvents() {
  bindLabelEvents();

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
      if (event.target.closest('.card-label-btn, .chip, .label-picker')) {
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
  const manageBtn = document.querySelector('#manage-labels');
  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      labelManagerOpen = true;
      render();
    });
  }

  const closeBtn = document.querySelector('#close-label-manager');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      labelManagerOpen = false;
      render();
    });
  }

  const overlay = document.querySelector('#label-modal-overlay');
  if (overlay) {
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        labelManagerOpen = false;
        render();
      }
    });
  }

  const createForm = document.querySelector('#label-create-form');
  if (createForm) {
    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
      if (!name) return;
      await apiCreateLabel(name, color);
      createForm.elements.name.value = '';
    });
  }

  document.querySelectorAll('.label-row').forEach((row) => {
    const id = row.dataset.labelId;
    const nameInput = row.querySelector('[data-action="rename"]');
    const colorInput = row.querySelector('[data-action="recolor"]');
    const deleteBtn = row.querySelector('[data-action="delete-label"]');

    const save = () => {
      const name = nameInput.value.trim();
      const color = colorInput.value;
      if (!name) {
        const current = (board.labels || []).find((l) => l.id === id);
        if (current) nameInput.value = current.name;
        return;
      }
      apiUpdateLabel(id, name, color);
    };
    nameInput.addEventListener('change', save);
    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        nameInput.blur();
      }
    });
    colorInput.addEventListener('change', save);
    deleteBtn.addEventListener('click', () => apiDeleteLabel(id));
  });

  document.querySelectorAll('[data-filter-label]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.filterLabel;
      if (activeFilter.has(id)) activeFilter.delete(id);
      else activeFilter.add(id);
      render();
    });
  });

  const clearFilter = document.querySelector('#clear-filter');
  if (clearFilter) {
    clearFilter.addEventListener('click', () => {
      activeFilter.clear();
      render();
    });
  }

  document.querySelectorAll('[data-label-menu]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = btn.dataset.labelMenu;
      openLabelMenuCardId = openLabelMenuCardId === id ? null : id;
      render();
    });
  });

  document.querySelectorAll('[data-toggle-label]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const cardEl = checkbox.closest('.card');
      const cardId = cardEl?.dataset.cardId;
      const labelId = checkbox.dataset.toggleLabel;
      if (!cardId || !labelId) return;
      if (checkbox.checked) apiAssignLabel(cardId, labelId);
      else apiUnassignLabel(cardId, labelId);
    });
  });

  document.querySelectorAll('[data-remove-label]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const cardEl = btn.closest('.card');
      const cardId = cardEl?.dataset.cardId;
      const labelId = btn.dataset.removeLabel;
      if (cardId && labelId) apiUnassignLabel(cardId, labelId);
    });
  });
}

async function apiCreateLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create label failed');
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function apiUpdateLabel(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update label failed');
  } catch (error) {
    setStatus(error.message, true);
    await loadBoard();
  }
}

async function apiDeleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 204) throw new Error('Delete label failed');
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function apiAssignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Assign failed');
  } catch (error) {
    setStatus(error.message, true);
    await loadBoard();
  }
}

async function apiUnassignLabel(cardId, labelId) {
  try {
    const response = await fetch(
      `${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`,
      { method: 'DELETE' }
    );
    if (!response.ok) throw new Error('Unassign failed');
  } catch (error) {
    setStatus(error.message, true);
    await loadBoard();
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
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
