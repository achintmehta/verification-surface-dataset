import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let openMenuCardId = null;

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
      <div id="status" class="status">Connecting…</div>
    </header>
    ${renderToolbar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
  bindLabelEvents();
}

function renderToolbar() {
  return `
    <section class="toolbar">
      <div class="filter-bar">
        <span class="toolbar-label">Filter:</span>
        ${
          labels.length === 0
            ? '<span class="toolbar-empty">No labels yet</span>'
            : labels
                .map(
                  (label) => `
            <button type="button" class="filter-chip${activeFilter.has(label.id) ? ' active' : ''}"
                    data-filter-label="${escapeHtml(label.id)}"
                    style="--chip-color: ${escapeHtml(label.color)}">
              <span class="chip-swatch" style="background:${escapeHtml(label.color)}"></span>
              ${escapeHtml(label.name)}
            </button>`
                )
                .join('')
        }
        ${
          activeFilter.size > 0
            ? '<button type="button" class="filter-clear" data-filter-clear>Clear filter</button>'
            : ''
        }
      </div>
      <button type="button" class="manage-labels-btn" data-open-label-manager>Manage labels</button>
    </section>
    ${renderLabelManager()}
  `;
}

let labelManagerOpen = false;

function renderLabelManager() {
  if (!labelManagerOpen) return '';
  return `
    <section class="label-manager" data-label-manager>
      <div class="label-manager-panel">
        <div class="label-manager-head">
          <h3>Labels</h3>
          <button type="button" class="label-manager-close" data-close-label-manager>×</button>
        </div>
        <ul class="label-list">
          ${
            labels.length === 0
              ? '<li class="label-list-empty">No labels yet. Create one below.</li>'
              : labels
                  .map(
                    (label) => `
            <li class="label-row" data-label-id="${escapeHtml(label.id)}">
              <input type="color" class="label-color" value="${escapeHtml(normalizeColorForInput(label.color))}" data-recolor="${escapeHtml(label.id)}" />
              <input type="text" class="label-name" value="${escapeHtml(label.name)}" data-rename="${escapeHtml(label.id)}" maxlength="60" />
              <button type="button" class="label-delete" data-delete-label="${escapeHtml(label.id)}">Delete</button>
            </li>`
                  )
                  .join('')
          }
        </ul>
        <form class="label-create" data-create-label>
          <input type="color" name="color" value="#2563eb" />
          <input type="text" name="name" placeholder="New label name" maxlength="60" autocomplete="off" />
          <button type="submit">Create</button>
        </form>
        <div class="label-manager-error" data-label-error></div>
      </div>
    </section>
  `;
}

function normalizeColorForInput(color) {
  if (typeof color !== 'string') return '#000000';
  const value = color.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    return '#' + value.slice(1).split('').map((c) => c + c).join('');
  }
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  return '#000000';
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

function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  const cardLabels = card.labels || [];
  return cardLabels.some((label) => activeFilter.has(label.id));
}

function renderCard(card) {
  const cardLabels = card.labels || [];
  const chips = cardLabels
    .map(
      (label) => `
      <span class="card-chip" style="background:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">
        <span class="card-chip-text">${escapeHtml(label.name)}</span>
        <button type="button" class="card-chip-remove" data-remove-label="${escapeHtml(label.id)}" data-card-id="${escapeHtml(card.id)}" title="Remove label">×</button>
      </span>`
    )
    .join('');

  const assignedIds = new Set(cardLabels.map((label) => label.id));
  const menu =
    openMenuCardId === card.id
      ? `
      <div class="card-label-menu" data-card-label-menu>
        ${
          labels.length === 0
            ? '<div class="card-label-menu-empty">No labels. Use “Manage labels”.</div>'
            : labels
                .map(
                  (label) => `
          <label class="card-label-option">
            <input type="checkbox" data-toggle-label="${escapeHtml(label.id)}" data-card-id="${escapeHtml(card.id)}" ${assignedIds.has(label.id) ? 'checked' : ''} />
            <span class="card-chip-swatch" style="background:${escapeHtml(label.color)}"></span>
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
      ${cardLabels.length ? `<div class="card-chips">${chips}</div>` : ''}
      <div class="card-footer">
        <button type="button" class="card-label-btn" data-toggle-menu="${escapeHtml(card.id)}">＋ Labels</button>
      </div>
      ${menu}
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

function applyMutation(message) {
  if (Array.isArray(message.labels)) {
    labels = [...message.labels].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    // Drop filters that point at deleted labels.
    for (const id of [...activeFilter]) {
      if (!labels.some((label) => label.id === id)) activeFilter.delete(id);
    }
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

function showLabelError(message) {
  const el = document.querySelector('[data-label-error]');
  if (el) el.textContent = message || '';
}

function bindLabelEvents() {
  // Filter chips
  document.querySelectorAll('[data-filter-label]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.filterLabel;
      if (activeFilter.has(id)) activeFilter.delete(id);
      else activeFilter.add(id);
      render();
    });
  });
  const clearBtn = document.querySelector('[data-filter-clear]');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilter.clear();
      render();
    });
  }

  // Label manager open/close
  const openBtn = document.querySelector('[data-open-label-manager]');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      labelManagerOpen = true;
      render();
    });
  }
  const closeBtn = document.querySelector('[data-close-label-manager]');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      labelManagerOpen = false;
      render();
    });
  }
  const backdrop = document.querySelector('[data-label-manager]');
  if (backdrop) {
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) {
        labelManagerOpen = false;
        render();
      }
    });
  }

  // Create label
  const createForm = document.querySelector('[data-create-label]');
  if (createForm) {
    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
      await createLabel(name, color);
    });
  }

  // Rename labels
  document.querySelectorAll('[data-rename]').forEach((input) => {
    input.addEventListener('change', async () => {
      await updateLabel(input.dataset.rename, { name: input.value.trim() });
    });
  });

  // Recolor labels
  document.querySelectorAll('[data-recolor]').forEach((input) => {
    input.addEventListener('change', async () => {
      await updateLabel(input.dataset.recolor, { color: input.value });
    });
  });

  // Delete labels
  document.querySelectorAll('[data-delete-label]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteLabel(btn.dataset.deleteLabel);
    });
  });

  // Card label menu toggle
  document.querySelectorAll('[data-toggle-menu]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = btn.dataset.toggleMenu;
      openMenuCardId = openMenuCardId === id ? null : id;
      render();
    });
  });

  // Card label assign/unassign via checkbox
  document.querySelectorAll('[data-toggle-label]').forEach((input) => {
    input.addEventListener('change', async () => {
      const labelId = input.dataset.toggleLabel;
      const cardId = input.dataset.cardId;
      if (input.checked) await assignLabel(cardId, labelId);
      else await unassignLabel(cardId, labelId);
    });
  });

  // Remove chip directly
  document.querySelectorAll('[data-remove-label]').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await unassignLabel(btn.dataset.cardId, btn.dataset.removeLabel);
    });
  });

  // Prevent drag interfering with menu controls
  document.querySelectorAll('.card-label-menu, .card-chip-remove, .card-label-btn').forEach((el) => {
    el.addEventListener('mousedown', (event) => event.stopPropagation());
    el.setAttribute('draggable', 'false');
  });
}

async function createLabel(name, color) {
  showLabelError('');
  if (!name) {
    showLabelError('Name must not be empty.');
    return;
  }
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
    const created = await response.json();
    upsertLabel(created);
    render();
  } catch (error) {
    showLabelError(error.message);
  }
}

async function updateLabel(id, payload) {
  showLabelError('');
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update failed');
    const updated = await response.json();
    upsertLabel(updated);
    render();
  } catch (error) {
    showLabelError(error.message);
    await loadLabels();
    render();
  }
}

async function deleteLabel(id) {
  showLabelError('');
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Delete failed');
    labels = labels.filter((label) => label.id !== id);
    activeFilter.delete(id);
    render();
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

function upsertLabel(label) {
  const index = labels.findIndex((existing) => existing.id === label.id);
  if (index === -1) labels.push(label);
  else labels[index] = label;
  labels.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

async function loadLabels() {
  const response = await fetch(`${API_BASE}/api/labels`);
  if (!response.ok) throw new Error('Could not load labels');
  labels = await response.json();
}

async function loadBoard() {
  const [boardResponse] = await Promise.all([fetch(`${API_BASE}/api/board`), loadLabels()]);
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
