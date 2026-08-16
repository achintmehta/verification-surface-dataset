import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [], labels: [] };
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labels = [];
const activeFilter = new Set();
let openLabelMenuCardId = null;
let labelManagerOpen = false;

const DEFAULT_LABEL_COLOR = '#2563eb';

function getLabelById(id) {
  return labels.find((label) => label.id === id) || null;
}

function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  const cardLabels = card.labels || [];
  return cardLabels.some((label) => activeFilter.has(label.id));
}

function readableTextColor(hex) {
  let value = String(hex || '').replace('#', '');
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  const r = parseInt(value.slice(0, 2), 16) || 0;
  const g = parseInt(value.slice(2, 4), 16) || 0;
  const b = parseInt(value.slice(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1f2937' : '#ffffff';
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
  return { columns, labels: nextBoard.labels || [] };
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
        <button type="button" class="manage-labels-btn" data-action="toggle-label-manager">Manage labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
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
    <div class="filter-bar">
      <span class="filter-label">Filter:</span>
      <div class="filter-chips">
        ${
          labels.length === 0
            ? '<span class="filter-empty">No labels yet</span>'
            : labels
                .map((label) => {
                  const active = activeFilter.has(label.id);
                  return `<button type="button" class="filter-chip${active ? ' active' : ''}"
                    data-action="toggle-filter" data-label-id="${escapeHtml(label.id)}"
                    style="background:${escapeHtml(label.color)};color:${readableTextColor(label.color)};border-color:${escapeHtml(label.color)}">
                    ${escapeHtml(label.name)}${active ? ' ✓' : ''}
                  </button>`;
                })
                .join('')
        }
      </div>
      ${activeFilter.size > 0 ? '<button type="button" class="clear-filter" data-action="clear-filter">Clear filter</button>' : ''}
    </div>
  `;
}

function renderLabelManager() {
  if (!labelManagerOpen) return '';
  return `
    <div class="modal-overlay" data-action="close-label-manager">
      <div class="modal" data-stop="true">
        <div class="modal-header">
          <h2>Manage labels</h2>
          <button type="button" class="icon-btn" data-action="close-label-manager">✕</button>
        </div>
        <ul class="label-list">
          ${
            labels.length === 0
              ? '<li class="label-list-empty">No labels yet. Create one below.</li>'
              : labels
                  .map(
                    (label) => `
              <li class="label-row" data-label-id="${escapeHtml(label.id)}">
                <input type="color" value="${escapeHtml(label.color)}" data-action="recolor-label" data-label-id="${escapeHtml(label.id)}" />
                <input type="text" class="label-name-input" value="${escapeHtml(label.name)}" data-label-id="${escapeHtml(label.id)}" maxlength="100" />
                <button type="button" class="label-save-btn" data-action="rename-label" data-label-id="${escapeHtml(label.id)}">Save</button>
                <button type="button" class="label-delete-btn" data-action="delete-label" data-label-id="${escapeHtml(label.id)}">Delete</button>
              </li>`
                  )
                  .join('')
          }
        </ul>
        <form class="create-label" data-action="create-label">
          <input type="color" name="color" value="${DEFAULT_LABEL_COLOR}" />
          <input type="text" name="name" placeholder="New label name…" maxlength="100" autocomplete="off" />
          <button type="submit">Create label</button>
        </form>
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
  const cardLabels = card.labels || [];
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      ${
        cardLabels.length
          ? `<div class="card-chips">${cardLabels
              .map(
                (label) => `<span class="chip" style="background:${escapeHtml(label.color)};color:${readableTextColor(
                  label.color
                )}" data-label-id="${escapeHtml(label.id)}" title="${escapeHtml(label.name)}">
                  ${escapeHtml(label.name)}
                  <button type="button" class="chip-remove" data-action="unassign-label" data-card-id="${escapeHtml(
                    card.id
                  )}" data-label-id="${escapeHtml(label.id)}" title="Remove label">×</button>
                </span>`
              )
              .join('')}</div>`
          : ''
      }
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-footer">
        <button type="button" class="card-label-btn" data-action="open-label-menu" data-card-id="${escapeHtml(
          card.id
        )}">+ Label</button>
      </div>
      ${openLabelMenuCardId === card.id ? renderLabelMenu(card) : ''}
    </article>
  `;
}

function renderLabelMenu(card) {
  const assigned = new Set((card.labels || []).map((label) => label.id));
  return `
    <div class="label-menu" data-stop="true">
      ${
        labels.length === 0
          ? '<div class="label-menu-empty">No labels. Use “Manage labels”.</div>'
          : labels
              .map((label) => {
                const isAssigned = assigned.has(label.id);
                return `<button type="button" class="label-menu-item${isAssigned ? ' assigned' : ''}"
                  data-action="${isAssigned ? 'unassign-label' : 'assign-label'}"
                  data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}">
                  <span class="swatch" style="background:${escapeHtml(label.color)}"></span>
                  <span class="label-menu-name">${escapeHtml(label.name)}</span>
                  ${isAssigned ? '<span class="check">✓</span>' : ''}
                </button>`;
              })
              .join('')
      }
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

function syncLabelsFromBoard() {
  labels = [...(board.labels || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  // Drop filters that reference deleted labels.
  for (const id of [...activeFilter]) {
    if (!getLabelById(id)) activeFilter.delete(id);
  }
}

function applyMutation(message) {
  if (Array.isArray(message.labels)) {
    board.labels = message.labels;
    syncLabelsFromBoard();
  }

  if (message.board) {
    board = normalizeBoard(message.board);
    syncLabelsFromBoard();
    render();
    setStatus('Synced');
    return;
  }

  if (Array.isArray(message.labels)) {
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
  syncLabelsFromBoard();
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

async function apiFetch(url, options) {
  const response = await fetch(`${API_BASE}${url}`, options);
  if (!response.ok) {
    let message = 'Request failed';
    try {
      message = (await response.json()).error || message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return response;
}

async function createLabel(name, color) {
  await apiFetch('/api/labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color }),
  });
}

async function updateLabel(id, patch) {
  await apiFetch(`/api/labels/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

async function deleteLabel(id) {
  await apiFetch(`/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function assignLabel(cardId, labelId) {
  await apiFetch(`/api/cards/${encodeURIComponent(cardId)}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labelId }),
  });
}

async function unassignLabel(cardId, labelId) {
  await apiFetch(`/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, {
    method: 'DELETE',
  });
}

function installLabelHandlers() {
  document.addEventListener('click', async (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) {
      // Clicking outside an open label menu closes it.
      if (openLabelMenuCardId && !event.target.closest('.label-menu')) {
        openLabelMenuCardId = null;
        render();
      }
      return;
    }
    const action = actionEl.dataset.action;
    const cardId = actionEl.dataset.cardId;
    const labelId = actionEl.dataset.labelId;

    switch (action) {
      case 'toggle-label-manager':
        labelManagerOpen = true;
        render();
        break;
      case 'close-label-manager':
        // Close on the ✕ button, or when clicking the overlay backdrop itself
        // (not when clicking inside the modal body).
        if (actionEl.classList.contains('icon-btn') || event.target === actionEl) {
          labelManagerOpen = false;
          render();
        }
        break;
      case 'toggle-filter':
        if (activeFilter.has(labelId)) activeFilter.delete(labelId);
        else activeFilter.add(labelId);
        render();
        break;
      case 'clear-filter':
        activeFilter.clear();
        render();
        break;
      case 'open-label-menu':
        openLabelMenuCardId = openLabelMenuCardId === cardId ? null : cardId;
        render();
        break;
      case 'assign-label':
        try {
          await assignLabel(cardId, labelId);
        } catch (error) {
          setStatus(`Assign failed: ${error.message}`, true);
        }
        break;
      case 'unassign-label':
        try {
          await unassignLabel(cardId, labelId);
        } catch (error) {
          setStatus(`Remove failed: ${error.message}`, true);
        }
        break;
      case 'delete-label':
        try {
          await deleteLabel(labelId);
        } catch (error) {
          setStatus(`Delete failed: ${error.message}`, true);
        }
        break;
      case 'rename-label': {
        const input = document.querySelector(`.label-name-input[data-label-id="${cssEscape(labelId)}"]`);
        const colorInput = document.querySelector(`input[data-action="recolor-label"][data-label-id="${cssEscape(labelId)}"]`);
        try {
          await updateLabel(labelId, { name: input ? input.value : '', color: colorInput ? colorInput.value : undefined });
        } catch (error) {
          setStatus(`Rename failed: ${error.message}`, true);
        }
        break;
      }
      default:
        break;
    }
  });

  document.addEventListener('change', async (event) => {
    const el = event.target.closest('[data-action="recolor-label"]');
    if (!el) return;
    const labelId = el.dataset.labelId;
    try {
      await updateLabel(labelId, { color: el.value });
    } catch (error) {
      setStatus(`Recolor failed: ${error.message}`, true);
    }
  });

  document.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-action="create-label"]');
    if (!form) return;
    event.preventDefault();
    const name = form.elements.name.value;
    const color = form.elements.color.value;
    try {
      await createLabel(name, color);
      labelManagerOpen = true;
      // Reset name field; render will rebuild from state, so just clear input now.
      form.elements.name.value = '';
    } catch (error) {
      setStatus(`Create label failed: ${error.message}`, true);
    }
  });
}

function cssEscape(value) {
  if (window.CSS && window.CSS.escape) return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

async function start() {
  app.innerHTML = '<div class="loading">Loading board…</div>';
  installLabelHandlers();
  try {
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
