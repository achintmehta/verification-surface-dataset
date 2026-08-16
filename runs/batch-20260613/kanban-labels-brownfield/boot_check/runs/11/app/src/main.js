import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set(); // label ids selected in the filter bar
let menuCardId = null; // card whose label menu is open
let labelManagerOpen = false;
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

const DEFAULT_COLOR = '#2563eb';

function findLabel(id) {
  return labels.find((label) => label.id === id) || null;
}

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
    <div class="toolbar">
      <div class="filter-bar">
        <span class="filter-label">Filter:</span>
        <div class="filter-chips">
          ${
            labels.length === 0
              ? '<span class="filter-empty">No labels yet</span>'
              : labels
                  .map((label) => {
                    const active = activeFilter.has(label.id);
                    return `<button type="button" class="filter-chip${active ? ' active' : ''}" data-filter-label-id="${escapeHtml(label.id)}" style="--chip-color:${escapeHtml(label.color)}">${escapeHtml(label.name)}</button>`;
                  })
                  .join('')
          }
        </div>
        ${activeFilter.size > 0 ? '<button type="button" class="clear-filter" id="clear-filter">Clear filter</button>' : ''}
      </div>
      <button type="button" class="manage-labels-btn" id="manage-labels">Manage labels</button>
    </div>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${labelManagerOpen ? renderLabelManager() : ''}
    ${menuCardId ? renderCardLabelMenu(menuCardId) : ''}
  `;
  bindEvents();
}

function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  const cardLabelIds = (card.labels || []).map((label) => label.id);
  return cardLabelIds.some((id) => activeFilter.has(id));
}

function renderLabelManager() {
  return `
    <div class="modal-overlay" data-overlay="label-manager">
      <div class="modal label-manager">
        <div class="modal-header">
          <h3>Manage labels</h3>
          <button type="button" class="modal-close" id="close-label-manager">×</button>
        </div>
        <ul class="label-list">
          ${
            labels.length === 0
              ? '<li class="label-list-empty">No labels yet. Create one below.</li>'
              : labels.map(renderLabelRow).join('')
          }
        </ul>
        <form class="label-create-form" id="label-create-form">
          <input type="color" name="color" value="${DEFAULT_COLOR}" />
          <input type="text" name="name" maxlength="100" placeholder="New label name…" autocomplete="off" />
          <button type="submit">Add label</button>
        </form>
        <p class="label-error" id="label-error"></p>
      </div>
    </div>
  `;
}

function renderLabelRow(label) {
  return `
    <li class="label-row" data-label-id="${escapeHtml(label.id)}">
      <input type="color" class="label-row-color" value="${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}" />
      <input type="text" class="label-row-name" value="${escapeHtml(label.name)}" maxlength="100" data-label-id="${escapeHtml(label.id)}" />
      <button type="button" class="label-row-save" data-label-id="${escapeHtml(label.id)}">Save</button>
      <button type="button" class="label-row-delete" data-label-id="${escapeHtml(label.id)}">Delete</button>
    </li>
  `;
}

function renderCardLabelMenu(cardId) {
  const found = findCard(cardId);
  if (!found) return '';
  const assigned = new Set((found.card.labels || []).map((label) => label.id));
  return `
    <div class="modal-overlay" data-overlay="card-menu">
      <div class="modal card-label-menu">
        <div class="modal-header">
          <h3>Labels for card</h3>
          <button type="button" class="modal-close" id="close-card-menu">×</button>
        </div>
        <ul class="card-label-options">
          ${
            labels.length === 0
              ? '<li class="label-list-empty">No labels yet. Use “Manage labels” to create some.</li>'
              : labels
                  .map((label) => {
                    const on = assigned.has(label.id);
                    return `<li>
                      <label class="card-label-option">
                        <input type="checkbox" data-toggle-card="${escapeHtml(cardId)}" data-toggle-label="${escapeHtml(label.id)}" ${on ? 'checked' : ''} />
                        <span class="chip" style="--chip-color:${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
                      </label>
                    </li>`;
                  })
                  .join('')
          }
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
  const chips = (card.labels || [])
    .map(
      (label) =>
        `<span class="chip" style="--chip-color:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`
    )
    .join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      ${chips ? `<div class="card-chips">${chips}</div>` : ''}
      <div class="card-text">${escapeHtml(card.text)}</div>
      <button type="button" class="card-labels-btn" data-open-card-menu="${escapeHtml(card.id)}" title="Edit labels">🏷</button>
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
  // Label catalog mutations (no card payload).
  if (message.type === 'label-create') {
    if (message.label && !findLabel(message.label.id)) labels.push(message.label);
    labels.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    render();
    setStatus('Synced');
    return;
  }
  if (message.type === 'label-update') {
    const existing = findLabel(message.label.id);
    if (existing) {
      existing.name = message.label.name;
      existing.color = message.label.color;
    } else {
      labels.push(message.label);
    }
    labels.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    // Reflect rename/recolor on already-assigned cards.
    for (const column of board.columns) {
      for (const card of column.cards) {
        if (card.labels) {
          card.labels = card.labels.map((l) => (l.id === message.label.id ? { ...message.label } : l));
        }
      }
    }
    render();
    setStatus('Synced');
    return;
  }
  if (message.type === 'label-delete') {
    labels = labels.filter((label) => label.id !== message.labelId);
    activeFilter.delete(message.labelId);
    for (const column of board.columns) {
      for (const card of column.cards) {
        if (card.labels) card.labels = card.labels.filter((l) => l.id !== message.labelId);
      }
    }
    render();
    setStatus('Synced');
    return;
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

async function loadLabels() {
  try {
    const response = await fetch(`${API_BASE}/api/labels`);
    if (!response.ok) throw new Error('Could not load labels');
    labels = await response.json();
  } catch {
    labels = [];
  }
}

async function createLabel(name, color) {
  const response = await fetch(`${API_BASE}/api/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Create label failed');
  }
  return response.json();
}

async function updateLabel(id, name, color) {
  const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Update label failed');
  }
  return response.json();
}

async function deleteLabel(id) {
  const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 204) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Delete label failed');
  }
}

async function assignLabel(cardId, labelId) {
  const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labelId }),
  });
  if (!response.ok) throw new Error('Assign label failed');
}

async function unassignLabel(cardId, labelId) {
  const response = await fetch(
    `${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`,
    { method: 'DELETE' }
  );
  if (!response.ok) throw new Error('Unassign label failed');
}

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
  render();
}

function bindLabelEvents() {
  // Toolbar: open label manager.
  document.querySelector('#manage-labels')?.addEventListener('click', () => {
    labelManagerOpen = true;
    render();
  });

  // Filter chips toggle.
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

  // Card label menu open.
  document.querySelectorAll('[data-open-card-menu]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      menuCardId = btn.dataset.openCardMenu;
      render();
    });
  });

  // Overlay / close buttons.
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeModals();
    });
  });
  document.querySelector('#close-label-manager')?.addEventListener('click', closeModals);
  document.querySelector('#close-card-menu')?.addEventListener('click', closeModals);

  // Label manager: create.
  document.querySelector('#label-create-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    const errorEl = document.querySelector('#label-error');
    if (errorEl) errorEl.textContent = '';
    if (!name) {
      if (errorEl) errorEl.textContent = 'Name is required.';
      return;
    }
    try {
      await createLabel(name, color);
      form.elements.name.value = '';
    } catch (error) {
      if (errorEl) errorEl.textContent = error.message;
    }
  });

  // Label manager: save (rename/recolor).
  document.querySelectorAll('.label-row-save').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.labelId;
      const nameInput = document.querySelector(`.label-row-name[data-label-id="${CSS.escape(id)}"]`);
      const colorInput = document.querySelector(`.label-row-color[data-label-id="${CSS.escape(id)}"]`);
      const errorEl = document.querySelector('#label-error');
      if (errorEl) errorEl.textContent = '';
      try {
        await updateLabel(id, nameInput.value.trim(), colorInput.value);
      } catch (error) {
        if (errorEl) errorEl.textContent = error.message;
      }
    });
  });

  // Label manager: delete.
  document.querySelectorAll('.label-row-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.labelId;
      const errorEl = document.querySelector('#label-error');
      if (errorEl) errorEl.textContent = '';
      try {
        await deleteLabel(id);
      } catch (error) {
        if (errorEl) errorEl.textContent = error.message;
      }
    });
  });

  // Card menu: toggle label assignment.
  document.querySelectorAll('[data-toggle-card]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const cardId = checkbox.dataset.toggleCard;
      const labelId = checkbox.dataset.toggleLabel;
      try {
        if (checkbox.checked) await assignLabel(cardId, labelId);
        else await unassignLabel(cardId, labelId);
      } catch (error) {
        setStatus(error.message, true);
        checkbox.checked = !checkbox.checked;
      }
    });
  });
}

function closeModals() {
  labelManagerOpen = false;
  menuCardId = null;
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
    await Promise.all([loadLabels(), loadBoard()]);
    render();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
