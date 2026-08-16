import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set(); // label ids currently filtering the view (client-only)
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelManagerOpen = false;
let openCardMenuId = null; // card id whose label menu is open

const DEFAULT_NEW_COLOR = '#2563eb';

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

function readableTextColor(hex) {
  const value = String(hex || '').replace('#', '');
  let r;
  let g;
  let b;
  if (value.length === 3) {
    r = parseInt(value[0] + value[0], 16);
    g = parseInt(value[1] + value[1], 16);
    b = parseInt(value[2] + value[2], 16);
  } else if (value.length === 6) {
    r = parseInt(value.slice(0, 2), 16);
    g = parseInt(value.slice(2, 4), 16);
    b = parseInt(value.slice(4, 6), 16);
  } else {
    return '#ffffff';
  }
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
      <div class="topbar-actions">
        <button id="manage-labels" class="ghost-btn" type="button">Manage labels</button>
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
  const chips = labels
    .map((label) => {
      const active = activeFilter.has(label.id);
      const fg = readableTextColor(label.color);
      return `
        <button
          type="button"
          class="filter-chip${active ? ' active' : ''}"
          data-filter-label-id="${escapeHtml(label.id)}"
          style="background:${escapeHtml(label.color)};color:${fg};"
          aria-pressed="${active}"
        >${escapeHtml(label.name)}</button>
      `;
    })
    .join('');

  return `
    <div class="filterbar">
      <span class="filterbar-title">Filter:</span>
      ${labels.length ? chips : '<span class="filterbar-empty">No labels yet — create some with “Manage labels”.</span>'}
      ${activeFilter.size ? '<button type="button" id="clear-filter" class="clear-filter">Clear filter</button>' : ''}
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
      ${hiddenCount > 0 ? `<p class="hidden-count">${hiddenCount} card${hiddenCount === 1 ? '' : 's'} hidden by filter</p>` : ''}
    </section>
  `;
}

function renderCard(card) {
  const cardLabels = card.labels || [];
  const chips = cardLabels
    .map((label) => {
      const fg = readableTextColor(label.color);
      return `<span class="card-chip" style="background:${escapeHtml(label.color)};color:${fg};" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`;
    })
    .join('');

  const menuOpen = openCardMenuId === card.id;
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-top">
        <span class="card-text">${escapeHtml(card.text)}</span>
        <button type="button" class="card-label-btn" data-card-menu-id="${escapeHtml(card.id)}" title="Edit labels">🏷</button>
      </div>
      ${chips ? `<div class="card-chips">${chips}</div>` : ''}
      ${menuOpen ? renderCardLabelMenu(card) : ''}
    </article>
  `;
}

function renderCardLabelMenu(card) {
  const assigned = new Set((card.labels || []).map((label) => label.id));
  const rows = labels.length
    ? labels
        .map((label) => {
          const checked = assigned.has(label.id);
          const fg = readableTextColor(label.color);
          return `
            <label class="card-menu-row">
              <input type="checkbox" data-assign-card-id="${escapeHtml(card.id)}" data-assign-label-id="${escapeHtml(label.id)}" ${checked ? 'checked' : ''} />
              <span class="card-chip" style="background:${escapeHtml(label.color)};color:${fg};">${escapeHtml(label.name)}</span>
            </label>
          `;
        })
        .join('')
    : '<p class="card-menu-empty">No labels yet.</p>';

  return `
    <div class="card-label-menu" data-card-menu-for="${escapeHtml(card.id)}">
      <div class="card-menu-head">Labels</div>
      ${rows}
    </div>
  `;
}

function renderLabelManager() {
  const rows = labels
    .map((label) => {
      return `
        <li class="label-row" data-label-id="${escapeHtml(label.id)}">
          <input type="color" class="label-color" value="${escapeHtml(normalizeColorForInput(label.color))}" data-edit-label-id="${escapeHtml(label.id)}" />
          <input type="text" class="label-name" value="${escapeHtml(label.name)}" maxlength="100" data-edit-name-id="${escapeHtml(label.id)}" />
          <button type="button" class="label-save" data-save-label-id="${escapeHtml(label.id)}">Save</button>
          <button type="button" class="label-delete" data-delete-label-id="${escapeHtml(label.id)}">Delete</button>
        </li>
      `;
    })
    .join('');

  return `
    <div class="modal-backdrop" id="label-modal-backdrop">
      <div class="modal" role="dialog" aria-label="Manage labels">
        <div class="modal-head">
          <h3>Manage labels</h3>
          <button type="button" id="close-label-manager" class="ghost-btn">Close</button>
        </div>
        <form class="label-create" id="label-create-form">
          <input type="color" id="new-label-color" value="${DEFAULT_NEW_COLOR}" />
          <input type="text" id="new-label-name" placeholder="New label name" maxlength="100" autocomplete="off" />
          <button type="submit">Create</button>
        </form>
        <ul class="label-list">
          ${labels.length ? rows : '<li class="label-empty">No labels yet.</li>'}
        </ul>
        <p class="modal-error" id="label-error"></p>
      </div>
    </div>
  `;
}

function normalizeColorForInput(color) {
  const value = String(color || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    const v = value.slice(1);
    return `#${v[0]}${v[0]}${v[1]}${v[1]}${v[2]}${v[2]}`.toLowerCase();
  }
  return DEFAULT_NEW_COLOR;
}

function setLabelError(message) {
  const el = document.querySelector('#label-error');
  if (el) el.textContent = message || '';
}

function bindEvents() {
  document.querySelector('#manage-labels')?.addEventListener('click', () => {
    labelManagerOpen = true;
    render();
  });

  document.querySelector('#close-label-manager')?.addEventListener('click', () => {
    labelManagerOpen = false;
    render();
  });

  document.querySelector('#label-modal-backdrop')?.addEventListener('click', (event) => {
    if (event.target.id === 'label-modal-backdrop') {
      labelManagerOpen = false;
      render();
    }
  });

  document.querySelector('#label-create-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = document.querySelector('#new-label-name').value.trim();
    const color = document.querySelector('#new-label-color').value;
    if (!name) {
      setLabelError('Name is required.');
      return;
    }
    await createLabel(name, color);
  });

  document.querySelectorAll('[data-save-label-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.saveLabelId;
      const name = document.querySelector(`[data-edit-name-id="${cssEscape(id)}"]`)?.value.trim();
      const color = document.querySelector(`[data-edit-label-id="${cssEscape(id)}"]`)?.value;
      if (!name) {
        setLabelError('Name is required.');
        return;
      }
      await updateLabel(id, name, color);
    });
  });

  document.querySelectorAll('[data-delete-label-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteLabel(btn.dataset.deleteLabelId);
    });
  });

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

  document.querySelectorAll('[data-card-menu-id]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = btn.dataset.cardMenuId;
      openCardMenuId = openCardMenuId === id ? null : id;
      render();
    });
  });

  document.querySelectorAll('[data-assign-card-id]').forEach((input) => {
    input.addEventListener('change', async (event) => {
      event.stopPropagation();
      const cardId = input.dataset.assignCardId;
      const labelId = input.dataset.assignLabelId;
      if (input.checked) await assignLabelToCard(cardId, labelId);
      else await unassignLabelFromCard(cardId, labelId);
    });
  });

  // Keep card label menus from triggering drag/card interactions
  document.querySelectorAll('.card-label-menu').forEach((menu) => {
    menu.addEventListener('click', (event) => event.stopPropagation());
  });

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
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
    const nameInput = document.querySelector('#new-label-name');
    if (nameInput) nameInput.value = '';
    setLabelError('');
  } catch (error) {
    setLabelError(error.message);
  }
}

async function updateLabel(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
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
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 204) throw new Error((await response.json()).error || 'Delete failed');
    activeFilter.delete(id);
    setLabelError('');
  } catch (error) {
    setLabelError(error.message);
  }
}

async function assignLabelToCard(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Assign failed');
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
    await loadBoard();
  }
}

async function unassignLabelFromCard(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Unassign failed');
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
    await loadBoard();
  }
}

function reconcileFilterAndMenu() {
  const labelIds = new Set(labels.map((label) => label.id));
  for (const id of [...activeFilter]) {
    if (!labelIds.has(id)) activeFilter.delete(id);
  }
  if (openCardMenuId && !findCard(openCardMenuId)) openCardMenuId = null;
}

function applyMutation(message) {
  // Label mutations: server includes labels in board, and may include a card.
  if (message.board) {
    board = normalizeBoard(message.board);
  } else if (message.card) {
    const card = message.card;
    removeCardEverywhere(card.id);
    const target = board.columns.find((column) => column.id === card.column_id || column.id === message.columnId);
    if (target) {
      target.cards.push(card);
      target.cards.sort(compareCards);
    }
  }

  if (Array.isArray(message.labels)) {
    labels = [...message.labels];
  }

  reconcileFilterAndMenu();
  render();
  setStatus('Synced');
}

async function loadBoard() {
  const [boardResponse, labelsResponse] = await Promise.all([
    fetch(`${API_BASE}/api/board`),
    fetch(`${API_BASE}/api/labels`),
  ]);
  if (!boardResponse.ok) throw new Error('Could not load board');
  board = normalizeBoard(await boardResponse.json());
  if (labelsResponse.ok) labels = await labelsResponse.json();
  reconcileFilterAndMenu();
  render();
}

async function reloadLabels() {
  try {
    const response = await fetch(`${API_BASE}/api/labels`);
    if (response.ok) labels = await response.json();
  } catch {
    // ignore — board payload already carries label data on cards
  }
}

function connectStream() {
  eventSource?.close();
  eventSource = new EventSource(`${API_BASE}/api/stream`);
  eventSource.addEventListener('connected', () => setStatus('Live'));
  eventSource.addEventListener('mutation', async (event) => {
    const message = JSON.parse(event.data);
    // Label list (names/colors) isn't embedded in the board payload, so for any
    // label-affecting mutation refresh the label catalogue, then apply the board.
    if (typeof message.type === 'string' && message.type.startsWith('label-')) {
      await reloadLabels();
    }
    applyMutation(message);
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
