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
        .map((card) => ({ ...card, labels: card.labels || [] }))
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

// ── Filtering helpers ─────────────────────────────────────────────────────────

function cardMatchesFilter(card) {
  if (activeFilters.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const filterId of activeFilters) {
    if (cardLabelIds.has(filterId)) return true;
  }
  return false;
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    ${renderLabelBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${renderLabelManager()}
  `;
  bindEvents();
}

// ── Label filter bar ──────────────────────────────────────────────────────────

function renderLabelBar() {
  if (allLabels.length === 0) {
    return `<div class="label-bar">
      <span class="label-bar__hint">No labels yet — create one below ↓</span>
      <button class="label-bar__manage-btn" id="toggle-label-manager">Manage Labels</button>
    </div>`;
  }
  const chips = allLabels.map((label) => {
    const active = activeFilters.has(label.id);
    return `<button
      class="label-chip label-chip--filter${active ? ' label-chip--active' : ''}"
      data-label-id="${escapeHtml(label.id)}"
      style="--chip-color:${escapeHtml(label.color)}"
      title="Filter by ${escapeHtml(label.name)}"
    >${escapeHtml(label.name)}</button>`;
  }).join('');

  const clearBtn = activeFilters.size > 0
    ? `<button class="label-bar__clear" id="clear-filters">✕ Clear filter</button>`
    : '';

  return `<div class="label-bar">
    <span class="label-bar__label">Filter:</span>
    <div class="label-bar__chips">${chips}</div>
    ${clearBtn}
    <button class="label-bar__manage-btn" id="toggle-label-manager">Manage Labels</button>
  </div>`;
}

// ── Label manager modal ───────────────────────────────────────────────────────

function renderLabelManager() {
  return `
    <div class="lm-overlay" id="label-manager-overlay" hidden>
      <div class="lm-panel" role="dialog" aria-modal="true" aria-label="Label Manager">
        <div class="lm-header">
          <h2>Label Manager</h2>
          <button class="lm-close" id="close-label-manager" aria-label="Close">✕</button>
        </div>

        <form class="lm-create-form" id="create-label-form">
          <input
            class="lm-input"
            name="name"
            type="text"
            maxlength="60"
            placeholder="Label name…"
            autocomplete="off"
            required
          />
          <input
            class="lm-color"
            name="color"
            type="color"
            value="#6366f1"
            title="Pick a color"
          />
          <button class="lm-btn lm-btn--primary" type="submit">Add Label</button>
        </form>
        <p class="lm-error" id="create-label-error" hidden></p>

        <ul class="lm-list" id="label-list">
          ${allLabels.map(renderLabelRow).join('')}
        </ul>
      </div>
    </div>
  `;
}

function renderLabelRow(label) {
  return `
    <li class="lm-row" data-label-id="${escapeHtml(label.id)}">
      <span class="lm-swatch" style="background:${escapeHtml(label.color)}"></span>
      <span class="lm-name" data-field="name">${escapeHtml(label.name)}</span>
      <div class="lm-row-actions">
        <button class="lm-btn lm-btn--edit" data-action="edit-label" data-label-id="${escapeHtml(label.id)}" title="Rename / recolor">Edit</button>
        <button class="lm-btn lm-btn--danger" data-action="delete-label" data-label-id="${escapeHtml(label.id)}" title="Delete label">Delete</button>
      </div>
    </li>
  `;
}

// ── Column / card render ──────────────────────────────────────────────────────

function renderColumn(column) {
  const visibleCards = column.cards.filter(cardMatchesFilter);
  const hiddenCount = column.cards.length - visibleCards.length;
  const hiddenNote = hiddenCount > 0
    ? `<p class="column-hidden-note">${hiddenCount} card${hiddenCount > 1 ? 's' : ''} hidden by filter</p>`
    : '';
  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      ${hiddenNote}
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${visibleCards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const labelChips = (card.labels || []).map((label) => `
    <span
      class="label-chip label-chip--card"
      style="--chip-color:${escapeHtml(label.color)}"
      data-label-id="${escapeHtml(label.id)}"
    >${escapeHtml(label.name)}</span>
  `).join('');

  const labelSection = `
    <div class="card-labels">
      ${labelChips}
      <button class="card-label-btn" data-action="open-assign" data-card-id="${escapeHtml(card.id)}" title="Assign labels">＋</button>
    </div>
  `;

  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelSection}
    </article>
  `;
}

// ── Label assignment popover ──────────────────────────────────────────────────

function openAssignPopover(cardId, anchorEl) {
  closeAssignPopover();

  const found = findCard(cardId);
  if (!found) return;
  const card = found.card;
  const assignedIds = new Set((card.labels || []).map((l) => l.id));

  const popover = document.createElement('div');
  popover.className = 'assign-popover';
  popover.dataset.popoverCardId = cardId;

  if (allLabels.length === 0) {
    popover.innerHTML = `<p class="assign-popover__empty">No labels yet. Create one in <em>Manage Labels</em>.</p>`;
  } else {
    const items = allLabels.map((label) => {
      const checked = assignedIds.has(label.id);
      return `<label class="assign-popover__item">
        <input type="checkbox" data-label-id="${escapeHtml(label.id)}" ${checked ? 'checked' : ''} />
        <span class="assign-popover__swatch" style="background:${escapeHtml(label.color)}"></span>
        <span>${escapeHtml(label.name)}</span>
      </label>`;
    }).join('');
    popover.innerHTML = `<div class="assign-popover__list">${items}</div>`;
  }

  document.body.appendChild(popover);

  // Position near anchor
  const rect = anchorEl.getBoundingClientRect();
  popover.style.top = `${rect.bottom + window.scrollY + 4}px`;
  popover.style.left = `${rect.left + window.scrollX}px`;

  // Checkbox change handler
  popover.addEventListener('change', async (e) => {
    const checkbox = e.target;
    if (checkbox.type !== 'checkbox') return;
    const labelId = checkbox.dataset.labelId;
    if (checkbox.checked) {
      await assignLabel(cardId, labelId);
    } else {
      await unassignLabel(cardId, labelId);
    }
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', outsidePopoverClick, { capture: true, once: false });
  }, 0);
}

function outsidePopoverClick(e) {
  const popover = document.querySelector('.assign-popover');
  if (!popover) {
    document.removeEventListener('click', outsidePopoverClick, { capture: true });
    return;
  }
  if (!popover.contains(e.target) && !e.target.closest('[data-action="open-assign"]')) {
    closeAssignPopover();
    document.removeEventListener('click', outsidePopoverClick, { capture: true });
  }
}

function closeAssignPopover() {
  document.querySelector('.assign-popover')?.remove();
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
      await createCard(form.dataset.columnId, text);
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
      const { afterId, beforeId } = getDropPosition(list, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });

  // Label filter chips
  document.querySelectorAll('.label-chip--filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      const labelId = btn.dataset.labelId;
      if (activeFilters.has(labelId)) {
        activeFilters.delete(labelId);
      } else {
        activeFilters.add(labelId);
      }
      render();
    });
  });

  // Clear filter
  document.getElementById('clear-filters')?.addEventListener('click', () => {
    activeFilters.clear();
    render();
  });

  // Toggle label manager
  document.getElementById('toggle-label-manager')?.addEventListener('click', () => {
    const overlay = document.getElementById('label-manager-overlay');
    if (overlay) overlay.hidden = !overlay.hidden;
  });

  // Close label manager
  document.getElementById('close-label-manager')?.addEventListener('click', () => {
    const overlay = document.getElementById('label-manager-overlay');
    if (overlay) overlay.hidden = true;
  });

  // Close on overlay backdrop click
  document.getElementById('label-manager-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      e.currentTarget.hidden = true;
    }
  });

  // Create label form
  document.getElementById('create-label-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    const errEl = document.getElementById('create-label-error');
    errEl.hidden = true;
    if (!name) return;
    const err = await apiCreateLabel(name, color);
    if (err) {
      errEl.textContent = err;
      errEl.hidden = false;
    } else {
      form.elements.name.value = '';
    }
  });

  // Label list actions (edit / delete)
  document.getElementById('label-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const labelId = btn.dataset.labelId;

    if (action === 'delete-label') {
      if (!confirm('Delete this label? It will be removed from all cards.')) return;
      await apiDeleteLabel(labelId);
    }

    if (action === 'edit-label') {
      const label = allLabels.find((l) => l.id === labelId);
      if (!label) return;
      openEditInline(labelId, label);
    }
  });

  // Card label assign button
  document.querySelectorAll('[data-action="open-assign"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      const existing = document.querySelector('.assign-popover');
      if (existing && existing.dataset.popoverCardId === cardId) {
        closeAssignPopover();
      } else {
        openAssignPopover(cardId, btn);
      }
    });
  });
}

// ── Inline edit for labels ────────────────────────────────────────────────────

function openEditInline(labelId, label) {
  const row = document.querySelector(`.lm-row[data-label-id="${labelId}"]`);
  if (!row) return;

  // Replace row content with an edit form
  row.innerHTML = `
    <form class="lm-edit-form" data-label-id="${escapeHtml(labelId)}">
      <input class="lm-input" name="name" type="text" maxlength="60" value="${escapeHtml(label.name)}" required autocomplete="off" />
      <input class="lm-color" name="color" type="color" value="${escapeHtml(label.color)}" />
      <button class="lm-btn lm-btn--primary" type="submit">Save</button>
      <button class="lm-btn" type="button" data-action="cancel-edit">Cancel</button>
    </form>
    <p class="lm-error" id="edit-label-error-${escapeHtml(labelId)}" hidden></p>
  `;

  row.querySelector('[data-action="cancel-edit"]').addEventListener('click', () => {
    row.innerHTML = renderLabelRow(label).trim();
    // Re-bind the new buttons
    row.querySelector('[data-action="edit-label"]').addEventListener('click', () => openEditInline(labelId, label));
    row.querySelector('[data-action="delete-label"]').addEventListener('click', async () => {
      if (!confirm('Delete this label? It will be removed from all cards.')) return;
      await apiDeleteLabel(labelId);
    });
  });

  row.querySelector('.lm-edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    const errEl = document.getElementById(`edit-label-error-${labelId}`);
    errEl.hidden = true;
    const err = await apiUpdateLabel(labelId, name, color);
    if (err) {
      errEl.textContent = err;
      errEl.hidden = false;
    }
  });
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function apiCreateLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) {
      const data = await response.json();
      return data.error || 'Failed to create label';
    }
    return null;
  } catch (error) {
    return error.message;
  }
}

async function apiUpdateLabel(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) {
      const data = await response.json();
      return data.error || 'Failed to update label';
    }
    return null;
  } catch (error) {
    return error.message;
  }
}

async function apiDeleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok) {
      const data = await response.json();
      setStatus(`Delete failed: ${data.error || 'unknown error'}`, true);
    }
  } catch (error) {
    setStatus(`Delete failed: ${error.message}`, true);
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
      const data = await response.json();
      setStatus(`Assign failed: ${data.error || 'unknown error'}`, true);
    }
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const data = await response.json();
      setStatus(`Unassign failed: ${data.error || 'unknown error'}`, true);
    }
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
  }
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
  }
}

// ── Drag helpers ──────────────────────────────────────────────────────────────

function getDropPosition(list, cardId) {
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
  target.cards.push({ ...card, labels: card.labels || [] });
  target.cards.sort(compareCards);
  render();
  setStatus('Synced');
}

function applyLabelMutation(message) {
  // All label mutations carry the full board; just replace state and re-render.
  if (message.board) {
    board = normalizeBoard(message.board);
  }

  // Sync allLabels from the board's label data or re-fetch
  switch (message.type) {
    case 'label-create': {
      if (!allLabels.find((l) => l.id === message.label.id)) {
        allLabels.push(message.label);
        allLabels.sort((a, b) => a.name.localeCompare(b.name));
      }
      break;
    }
    case 'label-update': {
      const idx = allLabels.findIndex((l) => l.id === message.label.id);
      if (idx !== -1) allLabels[idx] = message.label;
      else allLabels.push(message.label);
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
      break;
    }
    case 'label-delete': {
      allLabels = allLabels.filter((l) => l.id !== message.labelId);
      activeFilters.delete(message.labelId);
      break;
    }
    // card-label-assign / card-label-unassign: board already updated above
  }

  render();
  setStatus('Synced');
}

// ── Board loading ─────────────────────────────────────────────────────────────

async function loadBoard() {
  const [boardRes, labelsRes] = await Promise.all([
    fetch(`${API_BASE}/api/board`),
    fetch(`${API_BASE}/api/labels`),
  ]);
  if (!boardRes.ok) throw new Error('Could not load board');
  if (!labelsRes.ok) throw new Error('Could not load labels');
  board = normalizeBoard(await boardRes.json());
  allLabels = await labelsRes.json();
  render();
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
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
