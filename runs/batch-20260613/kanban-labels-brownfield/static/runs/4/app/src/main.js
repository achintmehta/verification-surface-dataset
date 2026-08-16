import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];          // [{id, name, color}, …]
let activeFilters = new Set(); // label ids currently selected for filtering
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

// ── Utilities ─────────────────────────────────────────────────────────────────

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
  return (
    Number(a.position) - Number(b.position) ||
    String(a.created_at).localeCompare(String(b.created_at)) ||
    a.id.localeCompare(b.id)
  );
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function cardMatchesFilter(card) {
  if (activeFilters.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const filterId of activeFilters) {
    if (cardLabelIds.has(filterId)) return true;
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
  if (allLabels.length === 0) return '';
  const chips = allLabels
    .map((label) => {
      const active = activeFilters.has(label.id);
      return `<button
        class="filter-chip${active ? ' active' : ''}"
        data-filter-label-id="${escapeHtml(label.id)}"
        style="--chip-color:${escapeHtml(label.color)}"
        title="Filter by ${escapeHtml(label.name)}"
      >${escapeHtml(label.name)}</button>`;
    })
    .join('');
  const clearBtn =
    activeFilters.size > 0
      ? `<button class="filter-clear" id="filter-clear-btn">Clear filter</button>`
      : '';
  return `<div class="filter-bar"><span class="filter-label-text">Filter:</span>${chips}${clearBtn}</div>`;
}

function renderColumn(column) {
  const visibleCards = column.cards.filter(cardMatchesFilter);
  const hiddenCount = column.cards.length - visibleCards.length;
  const hiddenNote =
    hiddenCount > 0
      ? `<p class="hidden-note">${hiddenCount} card${hiddenCount > 1 ? 's' : ''} hidden by filter</p>`
      : '';
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
      ${hiddenNote}
    </section>
  `;
}

function renderCard(card) {
  const labelsHtml = renderCardLabelChips(card);
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml}
      <div class="card-actions">
        <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷</button>
      </div>
    </article>
  `;
}

function renderCardLabelChips(card) {
  const labels = card.labels || [];
  if (labels.length === 0) return '';
  const chips = labels
    .map(
      (label) =>
        `<span class="label-chip" style="background:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`
    )
    .join('');
  return `<div class="card-labels">${chips}</div>`;
}

function renderLabelManager() {
  const rows = allLabels
    .map(
      (label) => `
      <tr data-label-id="${escapeHtml(label.id)}">
        <td>
          <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
        </td>
        <td class="label-name-cell">
          <input class="label-name-input" type="text" value="${escapeHtml(label.name)}" maxlength="100" data-label-id="${escapeHtml(label.id)}" />
        </td>
        <td>
          <input class="label-color-input" type="color" value="${escapeHtml(normalizeHexForInput(label.color))}" data-label-id="${escapeHtml(label.id)}" />
        </td>
        <td>
          <button class="label-save-btn" data-label-id="${escapeHtml(label.id)}">Save</button>
        </td>
        <td>
          <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}">Delete</button>
        </td>
      </tr>`
    )
    .join('');

  return `
    <section class="label-manager" id="label-manager">
      <h3>Labels</h3>
      <table class="label-table">
        <tbody id="label-tbody">
          ${rows}
        </tbody>
      </table>
      <form class="label-create-form" id="label-create-form">
        <input type="text" name="name" placeholder="Label name…" maxlength="100" autocomplete="off" required />
        <input type="color" name="color" value="#3b82f6" />
        <button type="submit">Create label</button>
      </form>
    </section>
  `;
}

// Normalize 3-digit hex to 6-digit for <input type="color">
function normalizeHexForInput(hex) {
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    const r = hex[1];
    const g = hex[2];
    const b = hex[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return hex;
}

// ── Card-label assignment modal ───────────────────────────────────────────────

function openLabelAssignModal(cardId) {
  const existing = document.getElementById('label-assign-modal');
  if (existing) existing.remove();

  const found = findCard(cardId);
  if (!found) return;
  const card = found.card;
  const assignedIds = new Set((card.labels || []).map((l) => l.id));

  const items = allLabels
    .map((label) => {
      const checked = assignedIds.has(label.id) ? 'checked' : '';
      return `
        <label class="assign-label-row">
          <input type="checkbox" ${checked} data-label-id="${escapeHtml(label.id)}" data-card-id="${escapeHtml(cardId)}" />
          <span class="label-chip" style="background:${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
        </label>`;
    })
    .join('');

  const noLabels = allLabels.length === 0 ? '<p class="no-labels-note">No labels yet. Create one below.</p>' : '';

  const modal = document.createElement('div');
  modal.id = 'label-assign-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <strong>Assign labels</strong>
        <button class="modal-close" id="modal-close-btn">✕</button>
      </div>
      <div class="modal-body">
        ${noLabels}
        ${items}
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  document.getElementById('modal-close-btn').addEventListener('click', () => modal.remove());

  modal.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const lId = checkbox.dataset.labelId;
      const cId = checkbox.dataset.cardId;
      if (checkbox.checked) {
        await assignLabel(cId, lId);
      } else {
        await unassignLabel(cId, lId);
      }
    });
  });
}

// ── Event binding ─────────────────────────────────────────────────────────────

function bindEvents() {
  // Add-card forms
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      input.disabled = true;
      await createCard(form.dataset.columnId, text);
      input.disabled = false;
      input.focus();
    });
  });

  // Drag-and-drop
  document.querySelectorAll('.card').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      draggedCardId = el.dataset.cardId;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      draggedCardId = null;
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      list.classList.add('drop-target');
    });
    list.addEventListener('dragleave', (e) => {
      if (!list.contains(e.relatedTarget)) list.classList.remove('drop-target');
    });
    list.addEventListener('drop', async (e) => {
      e.preventDefault();
      list.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = list.dataset.columnId;
      const { afterId, beforeId } = getDropNeighbours(list, draggedCardId);
      const cardId = draggedCardId;
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
      await moveCard(cardId, columnId, beforeId, afterId);
    });
  });

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const labelId = btn.dataset.filterLabelId;
      if (activeFilters.has(labelId)) {
        activeFilters.delete(labelId);
      } else {
        activeFilters.add(labelId);
      }
      render();
    });
  });

  // Clear filter
  const clearBtn = document.getElementById('filter-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilters.clear();
      render();
    });
  }

  // Card label buttons
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openLabelAssignModal(btn.dataset.cardId);
    });
  });

  // Label manager: create form
  const createForm = document.getElementById('label-create-form');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = createForm.elements.name;
      const colorInput = createForm.elements.color;
      const name = nameInput.value.trim();
      const color = colorInput.value;
      if (!name) return;
      nameInput.disabled = true;
      const ok = await createLabel(name, color);
      nameInput.disabled = false;
      if (ok) {
        nameInput.value = '';
        colorInput.value = '#3b82f6';
      }
      nameInput.focus();
    });
  }

  // Label manager: save buttons
  document.querySelectorAll('.label-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const row = btn.closest('tr');
      const nameInput = row.querySelector('.label-name-input');
      const colorInput = row.querySelector('.label-color-input');
      await updateLabel(labelId, nameInput.value.trim(), colorInput.value);
    });
  });

  // Label manager: delete buttons
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const label = allLabels.find((l) => l.id === labelId);
      if (!label) return;
      if (!confirm(`Delete label "${label.name}"? This will remove it from all cards.`)) return;
      await deleteLabel(labelId);
    });
  });

  // Label manager: color input preview
  document.querySelectorAll('.label-color-input').forEach((input) => {
    input.addEventListener('input', () => {
      const row = input.closest('tr');
      const swatch = row.querySelector('.label-swatch');
      if (swatch) swatch.style.background = input.value;
    });
  });
}

// ── Drag helpers ──────────────────────────────────────────────────────────────

function getDropNeighbours(list, cardId) {
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

// ── API calls ─────────────────────────────────────────────────────────────────

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
      const err = await response.json();
      setStatus(`Label error: ${err.error}`, true);
      return false;
    }
    return true;
  } catch (error) {
    setStatus(`Label error: ${error.message}`, true);
    return false;
  }
}

async function updateLabel(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) {
      const err = await response.json();
      setStatus(`Label error: ${err.error}`, true);
    }
  } catch (error) {
    setStatus(`Label error: ${error.message}`, true);
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      const err = await response.json();
      setStatus(`Label error: ${err.error}`, true);
    }
  } catch (error) {
    setStatus(`Label error: ${error.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) {
      const err = await response.json();
      setStatus(`Assign error: ${err.error}`, true);
    }
  } catch (error) {
    setStatus(`Assign error: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
      method: 'DELETE',
    });
    if (!response.ok && response.status !== 404) {
      const err = await response.json();
      setStatus(`Unassign error: ${err.error}`, true);
    }
  } catch (error) {
    setStatus(`Unassign error: ${error.message}`, true);
  }
}

// ── SSE / mutation handling ───────────────────────────────────────────────────

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

function applyLabelMutation(message) {
  const { type } = message;

  if (type === 'label-create') {
    const { label } = message;
    if (!allLabels.find((l) => l.id === label.id)) {
      allLabels.push(label);
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
    }
    render();
    setStatus('Synced');
    return;
  }

  if (type === 'label-update' || type === 'label-delete' || type === 'card-label-assign' || type === 'card-label-unassign') {
    // For all these cases the server sends the full board; use it as source of truth
    if (message.board) {
      board = normalizeBoard(message.board);
    }

    if (type === 'label-update' && message.label) {
      const idx = allLabels.findIndex((l) => l.id === message.label.id);
      if (idx !== -1) {
        allLabels[idx] = message.label;
      } else {
        allLabels.push(message.label);
      }
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
    }

    if (type === 'label-delete') {
      allLabels = allLabels.filter((l) => l.id !== message.labelId);
      // Remove from active filters if it was selected
      activeFilters.delete(message.labelId);
    }

    render();
    setStatus('Synced');
    return;
  }
}

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
}

async function loadLabels() {
  const response = await fetch(`${API_BASE}/api/labels`);
  if (!response.ok) throw new Error('Could not load labels');
  allLabels = await response.json();
}

function connectStream() {
  eventSource?.close();
  eventSource = new EventSource(`${API_BASE}/api/stream`);
  eventSource.addEventListener('connected', () => setStatus('Live'));
  eventSource.addEventListener('mutation', (event) => {
    applyMutation(JSON.parse(event.data));
  });
  eventSource.addEventListener('label-mutation', (event) => {
    applyLabelMutation(JSON.parse(event.data));
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
    statusTimer = setTimeout(
      () => setStatus(eventSource?.readyState === EventSource.OPEN ? 'Live' : 'Reconnecting…'),
      4000
    );
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
