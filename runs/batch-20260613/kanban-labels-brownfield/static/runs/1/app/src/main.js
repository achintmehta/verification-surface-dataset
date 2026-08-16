import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = []; // all known labels
let activeFilters = new Set(); // label ids currently selected for filtering
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

// ── Utilities ────────────────────────────────────────────────────────────────

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

// ── Filtering ────────────────────────────────────────────────────────────────

function cardMatchesFilter(card) {
  if (activeFilters.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const filterId of activeFilters) {
    if (cardLabelIds.has(filterId)) return true;
  }
  return false;
}

// ── Render ───────────────────────────────────────────────────────────────────

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div class="topbar-title">
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <button class="btn-manage-labels" id="btn-manage-labels">🏷 Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    <div id="label-manager-overlay" class="overlay hidden" role="dialog" aria-modal="true" aria-label="Label Manager">
      ${renderLabelManager()}
    </div>
  `;
  bindEvents();
}

function renderFilterBar() {
  if (labels.length === 0) return '';
  return `
    <div class="filter-bar" role="toolbar" aria-label="Filter by label">
      <span class="filter-label-text">Filter:</span>
      ${labels
        .map(
          (label) => `
        <button
          class="filter-chip${activeFilters.has(label.id) ? ' active' : ''}"
          data-filter-label-id="${escapeHtml(label.id)}"
          style="--chip-color: ${escapeHtml(label.color)}"
          title="Filter by ${escapeHtml(label.name)}"
          aria-pressed="${activeFilters.has(label.id)}"
        >${escapeHtml(label.name)}</button>
      `
        )
        .join('')}
      ${
        activeFilters.size > 0
          ? `<button class="filter-clear" id="btn-clear-filter" title="Clear all filters">✕ Clear</button>`
          : ''
      }
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
        ${hiddenCount > 0 ? `<div class="hidden-cards-notice">${hiddenCount} card${hiddenCount > 1 ? 's' : ''} hidden by filter</div>` : ''}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const cardLabels = card.labels || [];
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${
        cardLabels.length > 0
          ? `<div class="card-labels">${cardLabels.map(renderLabelChip).join('')}</div>`
          : ''
      }
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels" aria-label="Manage labels for this card">🏷</button>
    </article>
  `;
}

function renderLabelChip(label) {
  return `<span class="label-chip" style="background:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`;
}

function renderLabelManager() {
  return `
    <div class="label-manager">
      <div class="label-manager-header">
        <h2>Label Manager</h2>
        <button class="btn-close-manager" id="btn-close-manager" aria-label="Close label manager">✕</button>
      </div>
      <form class="label-create-form" id="label-create-form">
        <input
          type="text"
          name="name"
          maxlength="100"
          placeholder="Label name…"
          autocomplete="off"
          required
          aria-label="New label name"
        />
        <input
          type="color"
          name="color"
          value="#3b82f6"
          aria-label="Label color"
        />
        <button type="submit">Create</button>
      </form>
      <ul class="label-list" id="label-list">
        ${labels.map(renderLabelManagerItem).join('')}
      </ul>
    </div>
  `;
}

function renderLabelManagerItem(label) {
  return `
    <li class="label-item" data-label-id="${escapeHtml(label.id)}">
      <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
      <input
        class="label-name-input"
        type="text"
        value="${escapeHtml(label.name)}"
        maxlength="100"
        aria-label="Label name"
        data-label-id="${escapeHtml(label.id)}"
        data-original-name="${escapeHtml(label.name)}"
      />
      <input
        class="label-color-input"
        type="color"
        value="${escapeHtml(label.color)}"
        aria-label="Label color"
        data-label-id="${escapeHtml(label.id)}"
        data-original-color="${escapeHtml(label.color)}"
      />
      <button class="btn-save-label" data-label-id="${escapeHtml(label.id)}" title="Save changes">Save</button>
      <button class="btn-delete-label" data-label-id="${escapeHtml(label.id)}" title="Delete label">Delete</button>
    </li>
  `;
}

// ── Card label assignment popover ────────────────────────────────────────────

function openCardLabelPopover(cardId) {
  // Remove any existing popover
  closeCardLabelPopover();

  const found = findCard(cardId);
  if (!found) return;
  const card = found.card;
  const assignedIds = new Set((card.labels || []).map((l) => l.id));

  const popover = document.createElement('div');
  popover.className = 'card-label-popover';
  popover.dataset.popoverCardId = cardId;
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Assign labels');

  if (labels.length === 0) {
    popover.innerHTML = `<p class="popover-empty">No labels yet. Create some in the Label Manager.</p>`;
  } else {
    popover.innerHTML = `
      <p class="popover-title">Assign labels</p>
      <ul class="popover-label-list">
        ${labels
          .map(
            (label) => `
          <li>
            <label class="popover-label-item">
              <input
                type="checkbox"
                data-assign-card-id="${escapeHtml(cardId)}"
                data-assign-label-id="${escapeHtml(label.id)}"
                ${assignedIds.has(label.id) ? 'checked' : ''}
              />
              <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
              <span>${escapeHtml(label.name)}</span>
            </label>
          </li>
        `
          )
          .join('')}
      </ul>
    `;
  }

  // Position near the button that triggered it
  const btn = document.querySelector(`.card-label-btn[data-card-id="${CSS.escape(cardId)}"]`);
  document.body.appendChild(popover);

  if (btn) {
    const rect = btn.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    let top = rect.bottom + window.scrollY + 4;
    let left = rect.left + window.scrollX;
    // Keep within viewport
    if (left + popRect.width > window.innerWidth - 8) {
      left = window.innerWidth - popRect.width - 8;
    }
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
  }

  // Bind checkbox events
  popover.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.addEventListener('change', async (e) => {
      const cId = e.target.dataset.assignCardId;
      const lId = e.target.dataset.assignLabelId;
      if (e.target.checked) {
        await assignLabel(cId, lId);
      } else {
        await unassignLabel(cId, lId);
      }
    });
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', onOutsidePopoverClick, { capture: true, once: false });
  }, 0);
}

function onOutsidePopoverClick(e) {
  const popover = document.querySelector('.card-label-popover');
  if (!popover) {
    document.removeEventListener('click', onOutsidePopoverClick, { capture: true });
    return;
  }
  if (!popover.contains(e.target) && !e.target.closest('.card-label-btn')) {
    closeCardLabelPopover();
    document.removeEventListener('click', onOutsidePopoverClick, { capture: true });
  }
}

function closeCardLabelPopover() {
  document.querySelector('.card-label-popover')?.remove();
}

// ── Event binding ────────────────────────────────────────────────────────────

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
      const { afterId, beforeId } = getDropPosition(list, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });

  // Card label buttons
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      const existing = document.querySelector('.card-label-popover');
      if (existing && existing.dataset.popoverCardId === cardId) {
        closeCardLabelPopover();
      } else {
        openCardLabelPopover(cardId);
      }
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
  document.getElementById('btn-clear-filter')?.addEventListener('click', () => {
    activeFilters.clear();
    render();
  });

  // Label manager open/close
  document.getElementById('btn-manage-labels')?.addEventListener('click', () => {
    document.getElementById('label-manager-overlay')?.classList.remove('hidden');
  });
  document.getElementById('btn-close-manager')?.addEventListener('click', () => {
    document.getElementById('label-manager-overlay')?.classList.add('hidden');
  });
  document.getElementById('label-manager-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      e.currentTarget.classList.add('hidden');
    }
  });

  // Label create form
  document.getElementById('label-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return;
    form.querySelector('button[type="submit"]').disabled = true;
    await createLabel(name, color);
    form.querySelector('button[type="submit"]').disabled = false;
    form.elements.name.value = '';
  });

  // Save label buttons
  document.querySelectorAll('.btn-save-label').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const item = btn.closest('.label-item');
      const nameInput = item.querySelector('.label-name-input');
      const colorInput = item.querySelector('.label-color-input');
      const name = nameInput.value.trim();
      const color = colorInput.value;
      if (!name) return;
      btn.disabled = true;
      await updateLabel(labelId, name, color);
      btn.disabled = false;
    });
  });

  // Delete label buttons
  document.querySelectorAll('.btn-delete-label').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      if (!confirm('Delete this label? It will be removed from all cards.')) return;
      btn.disabled = true;
      await deleteLabel(labelId);
    });
  });

  // Sync color swatch in label manager when color input changes
  document.querySelectorAll('.label-color-input').forEach((input) => {
    input.addEventListener('input', () => {
      const swatch = input.closest('.label-item')?.querySelector('.label-swatch');
      if (swatch) swatch.style.background = input.value;
    });
  });
}

// ── Drag helpers ─────────────────────────────────────────────────────────────

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

// ── API calls ────────────────────────────────────────────────────────────────

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
    }
  } catch (error) {
    setStatus(`Label error: ${error.message}`, true);
  }
}

async function updateLabel(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
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
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const err = await response.json();
      setStatus(`Label error: ${err.error}`, true);
    }
  } catch (error) {
    setStatus(`Label error: ${error.message}`, true);
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

// ── SSE / mutation application ───────────────────────────────────────────────

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

function applyLabelEvent(message) {
  switch (message.type) {
    case 'label-created': {
      if (!labels.find((l) => l.id === message.label.id)) {
        labels.push(message.label);
        labels.sort((a, b) => a.name.localeCompare(b.name));
      }
      break;
    }
    case 'label-updated': {
      const idx = labels.findIndex((l) => l.id === message.label.id);
      if (idx !== -1) {
        labels[idx] = message.label;
      } else {
        labels.push(message.label);
      }
      labels.sort((a, b) => a.name.localeCompare(b.name));
      // Update label data on all cards
      for (const column of board.columns) {
        for (const card of column.cards) {
          const li = (card.labels || []).findIndex((l) => l.id === message.label.id);
          if (li !== -1) card.labels[li] = message.label;
        }
      }
      break;
    }
    case 'label-deleted': {
      labels = labels.filter((l) => l.id !== message.labelId);
      activeFilters.delete(message.labelId);
      // Remove from all cards
      for (const column of board.columns) {
        for (const card of column.cards) {
          card.labels = (card.labels || []).filter((l) => l.id !== message.labelId);
        }
      }
      break;
    }
    case 'label-assigned':
    case 'label-unassigned': {
      if (message.card) {
        // Replace card in board state with updated card from server
        const updatedCard = { ...message.card, labels: message.card.labels || [] };
        removeCardEverywhere(updatedCard.id);
        const target = board.columns.find((col) => col.id === updatedCard.column_id);
        if (target) {
          target.cards.push(updatedCard);
          target.cards.sort(compareCards);
        }
      }
      break;
    }
  }
  render();
  setStatus('Synced');
}

// ── Board loading & SSE ──────────────────────────────────────────────────────

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
  eventSource.addEventListener('label', (event) => {
    applyLabelEvent(JSON.parse(event.data));
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
