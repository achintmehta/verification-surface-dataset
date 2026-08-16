import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set(); // client-side view state: selected label ids
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let openMenuCardId = null; // which card's label menu is open
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
  return { columns };
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((label) => label.id));
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
        <button type="button" class="ghost-btn" id="open-label-manager">Manage labels</button>
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
                  return `
                    <button type="button"
                      class="filter-chip${active ? ' active' : ''}"
                      data-filter-label-id="${escapeHtml(label.id)}"
                      style="--chip-color: ${escapeHtml(label.color)};">
                      <span class="chip-dot"></span>${escapeHtml(label.name)}
                    </button>
                  `;
                })
                .join('')
        }
      </div>
      ${activeFilter.size > 0 ? '<button type="button" class="ghost-btn" id="clear-filter">Clear filter</button>' : ''}
    </div>
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
      </div>
      ${hiddenCount > 0 ? `<div class="hidden-count">${hiddenCount} card${hiddenCount === 1 ? '' : 's'} hidden by filter</div>` : ''}
    </section>
  `;
}

function renderCard(card) {
  const labelChips = (card.labels || [])
    .map(
      (label) => `
        <span class="card-chip" style="--chip-color: ${escapeHtml(label.color)};" title="${escapeHtml(label.name)}">
          <span class="card-chip-name">${escapeHtml(label.name)}</span>
        </span>
      `
    )
    .join('');

  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelChips ? `<div class="card-chips">${labelChips}</div>` : ''}
      <div class="card-footer">
        <button type="button" class="card-label-btn" data-label-menu-card-id="${escapeHtml(card.id)}">Labels</button>
      </div>
      ${openMenuCardId === card.id ? renderCardLabelMenu(card) : ''}
    </article>
  `;
}

function renderCardLabelMenu(card) {
  const assigned = new Set((card.labels || []).map((label) => label.id));
  return `
    <div class="label-menu" data-label-menu-for="${escapeHtml(card.id)}">
      ${
        labels.length === 0
          ? '<div class="label-menu-empty">No labels. Use “Manage labels” to create one.</div>'
          : labels
              .map((label) => {
                const checked = assigned.has(label.id);
                return `
                  <label class="label-menu-item">
                    <input type="checkbox"
                      data-toggle-label
                      data-card-id="${escapeHtml(card.id)}"
                      data-label-id="${escapeHtml(label.id)}"
                      ${checked ? 'checked' : ''} />
                    <span class="chip-dot" style="--chip-color: ${escapeHtml(label.color)};"></span>
                    <span>${escapeHtml(label.name)}</span>
                  </label>
                `;
              })
              .join('')
      }
    </div>
  `;
}

function renderLabelManager() {
  return `
    <div class="modal-backdrop" id="label-manager-backdrop">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-header">
          <h2>Labels</h2>
          <button type="button" class="ghost-btn" id="close-label-manager">Close</button>
        </div>
        <form class="label-create-form" id="label-create-form">
          <input name="name" type="text" maxlength="60" placeholder="Label name" autocomplete="off" />
          <input name="color" type="color" value="#2563eb" />
          <button type="submit">Add label</button>
        </form>
        <div class="label-manager-error" id="label-manager-error" hidden></div>
        <ul class="label-list">
          ${
            labels.length === 0
              ? '<li class="label-list-empty">No labels yet.</li>'
              : labels
                  .map(
                    (label) => `
                      <li class="label-list-item" data-label-id="${escapeHtml(label.id)}">
                        <input type="color" data-recolor-label-id="${escapeHtml(label.id)}" value="${escapeHtml(normalizeColorForInput(label.color))}" />
                        <input type="text" maxlength="60" data-rename-label-id="${escapeHtml(label.id)}" value="${escapeHtml(label.name)}" />
                        <span class="card-chip" style="--chip-color: ${escapeHtml(label.color)};"><span class="card-chip-name">${escapeHtml(label.name)}</span></span>
                        <button type="button" class="danger-btn" data-delete-label-id="${escapeHtml(label.id)}">Delete</button>
                      </li>
                    `
                  )
                  .join('')
          }
        </ul>
      </div>
    </div>
  `;
}

function normalizeColorForInput(color) {
  // <input type="color"> requires a 7-char #rrggbb value.
  if (typeof color !== 'string') return '#000000';
  const value = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    const r = value[1], g = value[2], b = value[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return '#000000';
}

function setLabelManagerError(message) {
  const el = document.querySelector('#label-manager-error');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
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
      const afterEl = getDragAfterElement(list, event.clientY);
      const draggingEl = document.querySelector('.card.dragging');
      if (!draggingEl) return;
      if (afterEl == null) {
        list.appendChild(draggingEl);
      } else {
        list.insertBefore(draggingEl, afterEl);
      }
    });
    list.addEventListener('dragleave', (event) => {
      if (event.target === list) list.classList.remove('drop-target');
    });
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      const cardId = draggedCardId;
      if (!cardId) return;
      const columnId = list.dataset.columnId;
      const { afterId, beforeId } = computeNeighbors(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
      await moveCard(cardId, columnId, beforeId, afterId);
    });
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

  // Per-card label menu toggle
  document.querySelectorAll('[data-label-menu-card-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = btn.dataset.labelMenuCardId;
      openMenuCardId = openMenuCardId === id ? null : id;
      render();
    });
  });

  // Assign/unassign within a card's menu
  document.querySelectorAll('[data-toggle-label]').forEach((input) => {
    input.addEventListener('change', async () => {
      const cardId = input.dataset.cardId;
      const labelId = input.dataset.labelId;
      if (input.checked) await assignLabel(cardId, labelId);
      else await unassignLabel(cardId, labelId);
    });
  });

  // Label manager
  document.querySelector('#open-label-manager')?.addEventListener('click', () => {
    labelManagerOpen = true;
    render();
  });
  document.querySelector('#close-label-manager')?.addEventListener('click', () => {
    labelManagerOpen = false;
    render();
  });
  document.querySelector('#label-manager-backdrop')?.addEventListener('click', (event) => {
    if (event.target.id === 'label-manager-backdrop') {
      labelManagerOpen = false;
      render();
    }
  });
  document.querySelector('#label-create-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) {
      setLabelManagerError('Name is required.');
      return;
    }
    setLabelManagerError(null);
    await createLabel(name, color);
  });
  document.querySelectorAll('[data-rename-label-id]').forEach((input) => {
    const commit = async () => {
      const id = input.dataset.renameLabelId;
      const label = labels.find((l) => l.id === id);
      if (!label) return;
      const name = input.value.trim();
      if (!name || name === label.name) {
        input.value = label.name;
        return;
      }
      await updateLabel(id, { name });
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
    });
  });
  document.querySelectorAll('[data-recolor-label-id]').forEach((input) => {
    input.addEventListener('change', async () => {
      const id = input.dataset.recolorLabelId;
      await updateLabel(id, { color: input.value });
    });
  });
  document.querySelectorAll('[data-delete-label-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteLabel(btn.dataset.deleteLabelId);
    });
  });
}

function getDragAfterElement(list, y) {
  const elements = [...list.querySelectorAll('.card:not(.dragging)')];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const child of elements) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, element: child };
    }
  }
  return closest.element;
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
    if (!response.ok) {
      const message = (await response.json()).error || 'Create label failed';
      setLabelManagerError(message);
      return;
    }
    const form = document.querySelector('#label-create-form');
    if (form) form.elements.name.value = '';
  } catch (error) {
    setLabelManagerError(error.message);
  }
}

async function updateLabel(id, changes) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    });
    if (!response.ok) {
      const message = (await response.json()).error || 'Update label failed';
      setLabelManagerError(message);
    }
  } catch (error) {
    setLabelManagerError(error.message);
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 204) {
      const message = (await response.json()).error || 'Delete label failed';
      setLabelManagerError(message);
    }
  } catch (error) {
    setLabelManagerError(error.message);
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

function setCardLabels(cardId, cardLabels) {
  const found = findCard(cardId);
  if (found) found.card.labels = cardLabels || [];
}

function applyMutation(message) {
  switch (message.type) {
    case 'label-create': {
      labels = upsertLabel(labels, message.label);
      render();
      setStatus('Synced');
      return;
    }
    case 'label-update': {
      labels = upsertLabel(labels, message.label);
      // Update chips already shown on cards.
      for (const column of board.columns) {
        for (const card of column.cards) {
          card.labels = (card.labels || []).map((label) =>
            label.id === message.label.id ? { ...label, ...message.label } : label
          );
        }
      }
      render();
      setStatus('Synced');
      return;
    }
    case 'label-delete': {
      labels = labels.filter((label) => label.id !== message.labelId);
      activeFilter.delete(message.labelId);
      for (const column of board.columns) {
        for (const card of column.cards) {
          card.labels = (card.labels || []).filter((label) => label.id !== message.labelId);
        }
      }
      render();
      setStatus('Synced');
      return;
    }
    case 'label-assign':
    case 'label-unassign': {
      setCardLabels(message.cardId, message.labels);
      render();
      setStatus('Synced');
      return;
    }
    default:
      break;
  }

  if (message.board) {
    board = normalizeBoard(message.board);
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

function upsertLabel(list, label) {
  const next = list.filter((existing) => existing.id !== label.id);
  next.push(label);
  next.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return next;
}

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
}

async function loadLabels() {
  const response = await fetch(`${API_BASE}/api/labels`);
  if (!response.ok) throw new Error('Could not load labels');
  labels = await response.json();
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
