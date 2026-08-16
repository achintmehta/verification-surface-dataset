import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set(); // label ids currently used to filter the board (client-side view state)
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let openCardMenuId = null; // card id whose label menu is open
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

// Drop the filter ids that no longer exist (e.g. a label was deleted elsewhere).
function pruneFilter() {
  const ids = new Set(labels.map((label) => label.id));
  for (const id of [...activeFilter]) {
    if (!ids.has(id)) activeFilter.delete(id);
  }
}

function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  return (card.labels || []).some((label) => activeFilter.has(label.id));
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
    ${labelManagerOpen ? renderLabelManager() : ''}
  `;
  bindEvents();
}

function renderFilterBar() {
  const filterChips = labels
    .map((label) => {
      const active = activeFilter.has(label.id);
      return `
        <button
          type="button"
          class="filter-chip${active ? ' active' : ''}"
          data-filter-label-id="${escapeHtml(label.id)}"
          style="--chip-color: ${escapeHtml(label.color)}"
          aria-pressed="${active}"
        >
          <span class="chip-dot" style="background:${escapeHtml(label.color)}"></span>
          ${escapeHtml(label.name)}
        </button>
      `;
    })
    .join('');

  return `
    <section class="filterbar">
      <div class="filterbar-left">
        <span class="filterbar-title">Filter:</span>
        ${labels.length ? filterChips : '<span class="filterbar-empty">No labels yet</span>'}
        ${activeFilter.size ? '<button type="button" class="clear-filter" id="clear-filter">Clear filter</button>' : ''}
      </div>
      <button type="button" class="manage-labels-btn" id="open-label-manager">Manage labels</button>
    </section>
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
  const chips = cardLabels
    .map(
      (label) => `
        <span class="label-chip" style="background:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">
          <span class="label-chip-text">${escapeHtml(label.name)}</span>
        </span>
      `
    )
    .join('');

  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-body">${escapeHtml(card.text)}</div>
      ${chips ? `<div class="card-labels">${chips}</div>` : ''}
      <div class="card-footer">
        <button type="button" class="label-toggle" data-card-id="${escapeHtml(card.id)}">＋ Labels</button>
      </div>
      ${openCardMenuId === card.id ? renderCardLabelMenu(card) : ''}
    </article>
  `;
}

function renderCardLabelMenu(card) {
  const assigned = new Set((card.labels || []).map((label) => label.id));
  const rows = labels.length
    ? labels
        .map((label) => {
          const checked = assigned.has(label.id);
          return `
            <label class="label-menu-row">
              <input type="checkbox" data-assign-card-id="${escapeHtml(card.id)}" data-assign-label-id="${escapeHtml(label.id)}" ${checked ? 'checked' : ''} />
              <span class="chip-dot" style="background:${escapeHtml(label.color)}"></span>
              <span>${escapeHtml(label.name)}</span>
            </label>
          `;
        })
        .join('')
    : '<p class="label-menu-empty">No labels yet. Create some via “Manage labels”.</p>';

  return `
    <div class="label-menu" data-card-menu-id="${escapeHtml(card.id)}">
      <div class="label-menu-header">Assign labels</div>
      ${rows}
    </div>
  `;
}

function renderLabelManager() {
  const rows = labels.length
    ? labels
        .map(
          (label) => `
            <li class="label-row" data-label-id="${escapeHtml(label.id)}">
              <input type="color" class="label-color" value="${escapeHtml(toHex6(label.color))}" data-label-id="${escapeHtml(label.id)}" />
              <input type="text" class="label-name" value="${escapeHtml(label.name)}" data-label-id="${escapeHtml(label.id)}" maxlength="60" />
              <button type="button" class="label-delete" data-label-id="${escapeHtml(label.id)}">Delete</button>
            </li>
          `
        )
        .join('')
    : '<li class="label-row-empty">No labels yet.</li>';

  return `
    <div class="modal-overlay" id="label-manager-overlay">
      <div class="modal" role="dialog" aria-label="Manage labels">
        <div class="modal-header">
          <h3>Manage labels</h3>
          <button type="button" class="modal-close" id="close-label-manager">×</button>
        </div>
        <form class="label-create-form" id="label-create-form">
          <input type="color" name="color" value="#2563eb" class="label-color" />
          <input type="text" name="name" placeholder="New label name" maxlength="60" autocomplete="off" />
          <button type="submit">Add label</button>
        </form>
        <ul class="label-list">${rows}</ul>
      </div>
    </div>
  `;
}

// Coerce #rgb to #rrggbb for the native color input which requires 6 digits.
function toHex6(value) {
  const v = String(value || '').trim();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return '#' + v.slice(1).split('').map((c) => c + c).join('');
  }
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  return '#2563eb';
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
        /* some browsers restrict this */
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
    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
      if (!cardId) return;
      const columnId = list.dataset.columnId;
      const { afterId, beforeId } = computeDropTarget(list, event.clientY, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
      await moveCard(cardId, columnId, beforeId, afterId);
    });
  });

  // Label filter chips
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

  // Label manager open/close
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

  // Create label
  document.querySelector('#label-create-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) {
      setStatus('Label name is required', true);
      return;
    }
    form.elements.name.value = '';
    await createLabel(name, color);
  });

  // Rename / recolor labels (commit on change)
  document.querySelectorAll('.label-name').forEach((input) => {
    input.addEventListener('change', async () => {
      const id = input.dataset.labelId;
      const name = input.value.trim();
      if (!name) {
        setStatus('Label name cannot be empty', true);
        return;
      }
      await updateLabel(id, { name });
    });
  });
  document.querySelectorAll('.label-color').forEach((input) => {
    if (!input.dataset.labelId) return;
    input.addEventListener('change', async () => {
      await updateLabel(input.dataset.labelId, { color: input.value });
    });
  });
  document.querySelectorAll('.label-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteLabel(btn.dataset.labelId);
    });
  });

  // Per-card label menu
  document.querySelectorAll('.label-toggle').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = btn.dataset.cardId;
      openCardMenuId = openCardMenuId === id ? null : id;
      render();
    });
  });
  document.querySelectorAll('[data-assign-label-id]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const cardId = checkbox.dataset.assignCardId;
      const labelId = checkbox.dataset.assignLabelId;
      if (checkbox.checked) await assignLabel(cardId, labelId);
      else await unassignLabel(cardId, labelId);
    });
  });
  // Keep the open menu from closing when interacting inside it.
  document.querySelectorAll('.label-menu').forEach((menu) => {
    menu.addEventListener('click', (event) => event.stopPropagation());
  });
}

function computeDropTarget(list, clientY, cardId) {
  const cardEls = [...list.querySelectorAll('.card')].filter((el) => el.dataset.cardId !== cardId);
  let beforeEl = null;
  for (const el of cardEls) {
    const rect = el.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      beforeEl = el;
      break;
    }
  }
  const ids = cardEls.map((el) => el.dataset.cardId);
  if (!beforeEl) {
    return { afterId: ids.length ? ids[ids.length - 1] : null, beforeId: null };
  }
  const beforeId = beforeEl.dataset.cardId;
  const beforeIndex = ids.indexOf(beforeId);
  return { afterId: beforeIndex > 0 ? ids[beforeIndex - 1] : null, beforeId };
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
    if (!response.ok) throw new Error((await response.json()).error || 'Create label failed');
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function updateLabel(id, patch) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update label failed');
  } catch (error) {
    setStatus(error.message, true);
    await refreshLabels();
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Delete label failed');
  } catch (error) {
    setStatus(error.message, true);
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
    setStatus(error.message, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Unassign failed');
  } catch (error) {
    setStatus(error.message, true);
  }
}

function upsertCard(card, columnId) {
  removeCardEverywhere(card.id);
  const target = board.columns.find((column) => column.id === card.column_id || column.id === columnId);
  if (!target) return;
  target.cards.push({ ...card, labels: card.labels || [] });
  target.cards.sort(compareCards);
}

function applyMutation(message) {
  // Label list / board snapshots arrive on label mutations.
  if (Array.isArray(message.labels)) {
    labels = [...message.labels].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    pruneFilter();
  }

  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (message.card) {
    upsertCard(message.card, message.columnId);
    render();
    setStatus('Synced');
    return;
  }

  // Label-only mutation (create) with no board snapshot.
  render();
  setStatus('Synced');
}

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
  render();
}

async function refreshLabels() {
  try {
    const response = await fetch(`${API_BASE}/api/labels`);
    if (!response.ok) throw new Error('Could not load labels');
    labels = (await response.json()).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    pruneFilter();
    render();
  } catch (error) {
    setStatus(error.message, true);
  }
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
    await Promise.all([loadBoard(), refreshLabels()]);
    render();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
