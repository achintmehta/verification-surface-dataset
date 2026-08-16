import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];          // [{id, name, color}, …]
let activeFilters = new Set(); // label ids currently selected for filtering
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

// Track which card's label popover is open
let openLabelPopoverCardId = null;
// Track whether the label manager modal is open
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

// ── Filter helpers ────────────────────────────────────────────────────────────

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
  const prevScrollY = window.scrollY;

  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-right">
        <button class="btn-label-manager" id="open-label-manager">🏷 Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${labelManagerOpen ? renderLabelManagerModal() : ''}
  `;

  window.scrollTo(0, prevScrollY);
  bindEvents();
}

function renderFilterBar() {
  if (allLabels.length === 0) return '';
  return `
    <div class="filter-bar">
      <span class="filter-label">Filter:</span>
      ${allLabels.map((label) => {
        const active = activeFilters.has(label.id);
        return `<button
          class="filter-chip${active ? ' active' : ''}"
          data-filter-label-id="${escapeHtml(label.id)}"
          style="--chip-color: ${escapeHtml(label.color)}"
          title="${escapeHtml(label.name)}"
        >${escapeHtml(label.name)}</button>`;
      }).join('')}
      ${activeFilters.size > 0 ? `<button class="filter-clear" id="clear-filters">✕ Clear</button>` : ''}
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
        ${column.cards.map((card) => renderCard(card, cardMatchesFilter(card))).join('')}
      </div>
    </section>
  `;
}

function renderCard(card, visible = true) {
  const labels = card.labels || [];
  const chipsHtml = labels.length > 0
    ? `<div class="card-chips">${labels.map((l) => `<span class="chip" style="background:${escapeHtml(l.color)}" title="${escapeHtml(l.name)}">${escapeHtml(l.name)}</span>`).join('')}</div>`
    : '';

  const isPopoverOpen = openLabelPopoverCardId === card.id;
  const popoverHtml = isPopoverOpen ? renderLabelPopover(card) : '';

  return `
    <article
      class="card${visible ? '' : ' card-hidden'}"
      draggable="${visible ? 'true' : 'false'}"
      data-card-id="${escapeHtml(card.id)}"
      title="${visible ? 'Drag to move' : ''}"
    >
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${chipsHtml}
      <div class="card-actions">
        <button class="btn-assign-label" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷</button>
      </div>
      ${popoverHtml}
    </article>
  `;
}

function renderLabelPopover(card) {
  const assignedIds = new Set((card.labels || []).map((l) => l.id));
  if (allLabels.length === 0) {
    return `
      <div class="label-popover" data-popover-card-id="${escapeHtml(card.id)}">
        <div class="popover-empty">No labels yet. Create one via the Labels button.</div>
      </div>
    `;
  }
  return `
    <div class="label-popover" data-popover-card-id="${escapeHtml(card.id)}">
      <div class="popover-title">Assign labels</div>
      ${allLabels.map((label) => {
        const assigned = assignedIds.has(label.id);
        return `
          <label class="popover-label-row">
            <input
              type="checkbox"
              class="label-assign-checkbox"
              data-card-id="${escapeHtml(card.id)}"
              data-label-id="${escapeHtml(label.id)}"
              ${assigned ? 'checked' : ''}
            />
            <span class="popover-chip" style="background:${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
          </label>
        `;
      }).join('')}
    </div>
  `;
}

function renderLabelManagerModal() {
  return `
    <div class="modal-overlay" id="label-manager-overlay">
      <div class="modal" id="label-manager-modal" role="dialog" aria-modal="true" aria-label="Label Manager">
        <div class="modal-header">
          <h2>Label Manager</h2>
          <button class="modal-close" id="close-label-manager" aria-label="Close">✕</button>
        </div>
        <div class="modal-body">
          <form class="label-create-form" id="label-create-form">
            <input
              type="text"
              name="name"
              placeholder="Label name…"
              maxlength="100"
              autocomplete="off"
              required
            />
            <input type="color" name="color" value="#3b82f6" title="Pick a color" />
            <button type="submit">Create</button>
          </form>
          <div id="label-create-error" class="label-error" style="display:none"></div>
          <ul class="label-list" id="label-list">
            ${allLabels.length === 0
              ? '<li class="label-list-empty">No labels yet.</li>'
              : allLabels.map(renderLabelRow).join('')}
          </ul>
        </div>
      </div>
    </div>
  `;
}

function renderLabelRow(label) {
  return `
    <li class="label-row" data-label-id="${escapeHtml(label.id)}">
      <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
      <span class="label-row-name" data-label-id="${escapeHtml(label.id)}">${escapeHtml(label.name)}</span>
      <div class="label-row-actions">
        <button class="btn-edit-label" data-label-id="${escapeHtml(label.id)}" title="Rename / recolor">✏️</button>
        <button class="btn-delete-label" data-label-id="${escapeHtml(label.id)}" title="Delete label">🗑</button>
      </div>
    </li>
  `;
}

// ── Event binding ─────────────────────────────────────────────────────────────

function bindEvents() {
  // Status element reference
  // (setStatus reads it from DOM each time)

  // Label manager open/close
  document.getElementById('open-label-manager')?.addEventListener('click', () => {
    labelManagerOpen = true;
    render();
  });
  document.getElementById('close-label-manager')?.addEventListener('click', () => {
    labelManagerOpen = false;
    render();
  });
  document.getElementById('label-manager-overlay')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('label-manager-overlay')) {
      labelManagerOpen = false;
      render();
    }
  });

  // Label create form
  document.getElementById('label-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    const errorEl = document.getElementById('label-create-error');
    errorEl.style.display = 'none';
    if (!name) return;
    try {
      const resp = await fetch(`${API_BASE}/api/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color }),
      });
      if (!resp.ok) {
        const data = await resp.json();
        errorEl.textContent = data.error || 'Failed to create label';
        errorEl.style.display = 'block';
        return;
      }
      form.elements.name.value = '';
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    }
  });

  // Label list actions (edit / delete)
  document.getElementById('label-list')?.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('.btn-edit-label');
    const deleteBtn = e.target.closest('.btn-delete-label');

    if (editBtn) {
      const labelId = editBtn.dataset.labelId;
      const label = allLabels.find((l) => l.id === labelId);
      if (!label) return;
      openEditLabelInline(labelId, label);
    }

    if (deleteBtn) {
      const labelId = deleteBtn.dataset.labelId;
      const label = allLabels.find((l) => l.id === labelId);
      if (!label) return;
      if (!confirm(`Delete label "${label.name}"? It will be removed from all cards.`)) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
        if (!resp.ok && resp.status !== 404) {
          const data = await resp.json().catch(() => ({}));
          setStatus(`Delete failed: ${data.error || resp.statusText}`, true);
        }
        // SSE will update allLabels and re-render
        activeFilters.delete(labelId);
      } catch (err) {
        setStatus(`Delete failed: ${err.message}`, true);
      }
    }
  });

  // Filter bar
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
  document.getElementById('clear-filters')?.addEventListener('click', () => {
    activeFilters.clear();
    render();
  });

  // Add-card forms
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      const columnId = form.dataset.columnId;
      await createCard(columnId, text);
    });
  });

  // Label assign buttons (open/close popover)
  document.querySelectorAll('.btn-assign-label').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      if (openLabelPopoverCardId === cardId) {
        openLabelPopoverCardId = null;
      } else {
        openLabelPopoverCardId = cardId;
      }
      render();
    });
  });

  // Label assign checkboxes
  document.querySelectorAll('.label-assign-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('change', async (e) => {
      const cardId = checkbox.dataset.cardId;
      const labelId = checkbox.dataset.labelId;
      if (e.target.checked) {
        await assignLabel(cardId, labelId);
      } else {
        await unassignLabel(cardId, labelId);
      }
    });
  });

  // Close popover when clicking outside
  document.addEventListener('click', handleOutsideClick, { once: true });

  // Drag-and-drop
  document.querySelectorAll('.card[draggable="true"]').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      draggedCardId = el.dataset.cardId;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      draggedCardId = null;
      el.classList.remove('dragging');
      document.querySelectorAll('.cards.drop-target').forEach((c) => c.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (e) => {
      if (!draggedCardId) return;
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
      const cardId = draggedCardId;
      const { afterId, beforeId } = getDropNeighbors(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
      await moveCard(cardId, columnId, beforeId, afterId);
    });
  });
}

function handleOutsideClick(e) {
  if (!openLabelPopoverCardId) return;
  const popover = document.querySelector(`.label-popover[data-popover-card-id="${openLabelPopoverCardId}"]`);
  const btn = document.querySelector(`.btn-assign-label[data-card-id="${openLabelPopoverCardId}"]`);
  if (popover && !popover.contains(e.target) && btn && !btn.contains(e.target)) {
    openLabelPopoverCardId = null;
    render();
  }
}

function openEditLabelInline(labelId, label) {
  const row = document.querySelector(`.label-row[data-label-id="${labelId}"]`);
  if (!row) return;

  // Replace the row content with an inline edit form
  row.innerHTML = `
    <form class="label-edit-form" data-label-id="${escapeHtml(labelId)}">
      <input type="color" name="color" value="${escapeHtml(label.color)}" title="Pick a color" />
      <input type="text" name="name" value="${escapeHtml(label.name)}" maxlength="100" autocomplete="off" required />
      <button type="submit">Save</button>
      <button type="button" class="btn-cancel-edit">Cancel</button>
    </form>
    <div class="label-edit-error" style="display:none"></div>
  `;

  const form = row.querySelector('.label-edit-form');
  form.elements.name.focus();
  form.elements.name.select();

  form.querySelector('.btn-cancel-edit').addEventListener('click', () => {
    // Restore original row
    row.innerHTML = renderLabelRow(label).replace(/<li[^>]*>|<\/li>/g, '');
    bindLabelRowEvents(row, labelId, label);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newName = form.elements.name.value.trim();
    const newColor = form.elements.color.value;
    const errorEl = row.querySelector('.label-edit-error');
    errorEl.style.display = 'none';
    if (!newName) return;
    try {
      const resp = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, color: newColor }),
      });
      if (!resp.ok) {
        const data = await resp.json();
        errorEl.textContent = data.error || 'Failed to update label';
        errorEl.style.display = 'block';
        return;
      }
      // SSE will re-render
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    }
  });
}

function bindLabelRowEvents(row, labelId, label) {
  row.querySelector('.btn-edit-label')?.addEventListener('click', () => openEditLabelInline(labelId, label));
  row.querySelector('.btn-delete-label')?.addEventListener('click', async () => {
    if (!confirm(`Delete label "${label.name}"? It will be removed from all cards.`)) return;
    try {
      await fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
      activeFilters.delete(labelId);
    } catch (err) {
      setStatus(`Delete failed: ${err.message}`, true);
    }
  });
}

function getDropNeighbors(list, cardId) {
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
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
  } catch (error) {
    setStatus(`Move failed: ${error.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const resp = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!resp.ok) throw new Error((await resp.json()).error || 'Assign failed');
  } catch (err) {
    setStatus(`Assign failed: ${err.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const resp = await fetch(
      `${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`,
      { method: 'DELETE' }
    );
    if (!resp.ok) throw new Error((await resp.json()).error || 'Unassign failed');
  } catch (err) {
    setStatus(`Unassign failed: ${err.message}`, true);
  }
}

async function loadLabels() {
  const resp = await fetch(`${API_BASE}/api/labels`);
  if (!resp.ok) throw new Error('Could not load labels');
  allLabels = await resp.json();
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
  // Always use the authoritative board from the server if provided
  if (message.board) {
    board = normalizeBoard(message.board);
  }

  const { type, label, labelId } = message;

  if (type === 'label-create' && label) {
    if (!allLabels.find((l) => l.id === label.id)) {
      allLabels.push(label);
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
    }
  } else if (type === 'label-update' && label) {
    const idx = allLabels.findIndex((l) => l.id === label.id);
    if (idx !== -1) {
      allLabels[idx] = label;
    } else {
      allLabels.push(label);
    }
    allLabels.sort((a, b) => a.name.localeCompare(b.name));
  } else if (type === 'label-delete' && labelId) {
    allLabels = allLabels.filter((l) => l.id !== labelId);
    activeFilters.delete(labelId);
  }
  // card-label-assign and card-label-unassign: board already updated above

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
