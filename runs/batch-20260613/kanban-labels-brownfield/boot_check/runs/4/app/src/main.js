import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = []; // all known labels
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

// ── Filtering ─────────────────────────────────────────────────────────────────

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
      <div class="topbar-title">
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-controls">
        ${renderFilterBar()}
        <button class="btn-label-manager" id="open-label-manager" title="Manage labels">🏷 Labels</button>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${renderLabelManagerModal()}
  `;
  bindEvents();
}

function renderFilterBar() {
  if (labels.length === 0) return '';
  return `
    <div class="filter-bar">
      <span class="filter-label">Filter:</span>
      ${labels
        .map(
          (label) => `
        <button
          class="filter-chip${activeFilters.has(label.id) ? ' active' : ''}"
          data-filter-label-id="${escapeHtml(label.id)}"
          style="--chip-color: ${escapeHtml(label.color)}"
          title="Filter by ${escapeHtml(label.name)}"
        >${escapeHtml(label.name)}</button>
      `
        )
        .join('')}
      ${
        activeFilters.size > 0
          ? `<button class="filter-clear" id="clear-filters" title="Clear all filters">✕ Clear</button>`
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
      <h2>${escapeHtml(column.title)}${hiddenCount > 0 ? ` <span class="hidden-count">(${hiddenCount} hidden)</span>` : ''}</h2>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${visibleCards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const labelsHtml =
    card.labels && card.labels.length > 0
      ? `<div class="card-labels">${card.labels
          .map(
            (label) =>
              `<span class="label-chip" style="background:${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`
          )
          .join('')}</div>`
      : '';

  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml}
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels for this card">🏷</button>
    </article>
  `;
}

// ── Label Manager Modal ───────────────────────────────────────────────────────

function renderLabelManagerModal() {
  return `
    <div class="modal-overlay" id="label-manager-overlay" style="display:none">
      <div class="modal" id="label-manager-modal" role="dialog" aria-modal="true" aria-label="Label Manager">
        <div class="modal-header">
          <h2>Label Manager</h2>
          <button class="modal-close" id="close-label-manager" title="Close">✕</button>
        </div>
        <div class="modal-body">
          <form class="label-create-form" id="label-create-form">
            <input
              type="text"
              name="name"
              maxlength="100"
              placeholder="Label name…"
              autocomplete="off"
              required
            />
            <input type="color" name="color" value="#3b82f6" title="Pick a color" />
            <button type="submit">Create</button>
          </form>
          <ul class="label-list" id="label-list">
            ${renderLabelList()}
          </ul>
        </div>
      </div>
    </div>
    <div class="modal-overlay" id="card-label-overlay" style="display:none">
      <div class="modal" id="card-label-modal" role="dialog" aria-modal="true" aria-label="Card Labels">
        <div class="modal-header">
          <h2>Card Labels</h2>
          <button class="modal-close" id="close-card-label-modal" title="Close">✕</button>
        </div>
        <div class="modal-body" id="card-label-modal-body">
        </div>
      </div>
    </div>
  `;
}

function renderLabelList() {
  if (labels.length === 0) return '<li class="label-list-empty">No labels yet. Create one above.</li>';
  return labels
    .map(
      (label) => `
    <li class="label-list-item" data-label-id="${escapeHtml(label.id)}">
      <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
      <input
        class="label-name-input"
        type="text"
        value="${escapeHtml(label.name)}"
        maxlength="100"
        data-label-id="${escapeHtml(label.id)}"
        data-original-name="${escapeHtml(label.name)}"
        aria-label="Label name"
      />
      <input
        class="label-color-input"
        type="color"
        value="${escapeHtml(label.color)}"
        data-label-id="${escapeHtml(label.id)}"
        title="Change color"
      />
      <button class="label-save-btn" data-label-id="${escapeHtml(label.id)}" title="Save changes">Save</button>
      <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete label">Delete</button>
    </li>
  `
    )
    .join('');
}

function renderCardLabelModalBody(cardId) {
  const found = findCard(cardId);
  if (!found) return '<p>Card not found.</p>';
  const card = found.card;
  const assignedIds = new Set((card.labels || []).map((l) => l.id));

  if (labels.length === 0) {
    return '<p class="label-list-empty">No labels exist yet. Create some in the Label Manager.</p>';
  }

  return `
    <ul class="card-label-list">
      ${labels
        .map((label) => {
          const assigned = assignedIds.has(label.id);
          return `
          <li class="card-label-item">
            <label class="card-label-toggle">
              <input
                type="checkbox"
                class="card-label-checkbox"
                data-card-id="${escapeHtml(cardId)}"
                data-label-id="${escapeHtml(label.id)}"
                ${assigned ? 'checked' : ''}
              />
              <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
              <span>${escapeHtml(label.name)}</span>
            </label>
          </li>
        `;
        })
        .join('')}
    </ul>
  `;
}

// ── Event binding ─────────────────────────────────────────────────────────────

function bindEvents() {
  // ── Add card forms ──
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

  // ── Drag and drop ──
  document.querySelectorAll('.card').forEach((el) => {
    el.addEventListener('dragstart', (event) => {
      draggedCardId = el.dataset.cardId;
      el.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      draggedCardId = null;
    });
  });

  document.querySelectorAll('.cards').forEach((container) => {
    container.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      container.classList.add('drop-target');
    });
    container.addEventListener('dragleave', (event) => {
      if (!container.contains(event.relatedTarget)) {
        container.classList.remove('drop-target');
      }
    });
    container.addEventListener('drop', async (event) => {
      event.preventDefault();
      container.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = container.dataset.columnId;
      const { afterId, beforeId } = getDropPosition(container, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });

  // ── Filter chips ──
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

  const clearFiltersBtn = document.getElementById('clear-filters');
  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener('click', () => {
      activeFilters.clear();
      render();
    });
  }

  // ── Label manager modal ──
  const openLabelManagerBtn = document.getElementById('open-label-manager');
  if (openLabelManagerBtn) {
    openLabelManagerBtn.addEventListener('click', () => {
      document.getElementById('label-manager-overlay').style.display = 'flex';
    });
  }

  const closeLabelManagerBtn = document.getElementById('close-label-manager');
  if (closeLabelManagerBtn) {
    closeLabelManagerBtn.addEventListener('click', () => {
      document.getElementById('label-manager-overlay').style.display = 'none';
    });
  }

  const labelManagerOverlay = document.getElementById('label-manager-overlay');
  if (labelManagerOverlay) {
    labelManagerOverlay.addEventListener('click', (e) => {
      if (e.target === labelManagerOverlay) {
        labelManagerOverlay.style.display = 'none';
      }
    });
  }

  // ── Label create form ──
  const labelCreateForm = document.getElementById('label-create-form');
  if (labelCreateForm) {
    labelCreateForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = labelCreateForm.elements.name;
      const colorInput = labelCreateForm.elements.color;
      const name = nameInput.value.trim();
      const color = colorInput.value;
      if (!name) return;
      const ok = await apiCreateLabel(name, color);
      if (ok) {
        nameInput.value = '';
        colorInput.value = '#3b82f6';
        // Refresh label list in modal
        const labelList = document.getElementById('label-list');
        if (labelList) labelList.innerHTML = renderLabelList();
        bindLabelListEvents();
      }
    });
  }

  bindLabelListEvents();

  // ── Card label button ──
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      openCardLabelModal(cardId);
    });
  });

  // ── Card label modal close ──
  const closeCardLabelBtn = document.getElementById('close-card-label-modal');
  if (closeCardLabelBtn) {
    closeCardLabelBtn.addEventListener('click', () => {
      document.getElementById('card-label-overlay').style.display = 'none';
    });
  }

  const cardLabelOverlay = document.getElementById('card-label-overlay');
  if (cardLabelOverlay) {
    cardLabelOverlay.addEventListener('click', (e) => {
      if (e.target === cardLabelOverlay) {
        cardLabelOverlay.style.display = 'none';
      }
    });
  }
}

function bindLabelListEvents() {
  // Save button
  document.querySelectorAll('.label-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const item = document.querySelector(`.label-list-item[data-label-id="${labelId}"]`);
      if (!item) return;
      const nameInput = item.querySelector('.label-name-input');
      const colorInput = item.querySelector('.label-color-input');
      const name = nameInput.value.trim();
      const color = colorInput.value;
      if (!name) {
        setStatus('Label name cannot be empty', true);
        return;
      }
      await apiUpdateLabel(labelId, name, color);
      // Update swatch immediately
      const swatch = item.querySelector('.label-swatch');
      if (swatch) swatch.style.background = color;
    });
  });

  // Delete button
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      if (!confirm('Delete this label? It will be removed from all cards.')) return;
      await apiDeleteLabel(labelId);
      const labelList = document.getElementById('label-list');
      if (labelList) labelList.innerHTML = renderLabelList();
      bindLabelListEvents();
    });
  });

  // Live color preview
  document.querySelectorAll('.label-color-input').forEach((input) => {
    input.addEventListener('input', () => {
      const item = input.closest('.label-list-item');
      if (!item) return;
      const swatch = item.querySelector('.label-swatch');
      if (swatch) swatch.style.background = input.value;
    });
  });
}

function openCardLabelModal(cardId) {
  const overlay = document.getElementById('card-label-overlay');
  const body = document.getElementById('card-label-modal-body');
  if (!overlay || !body) return;
  body.innerHTML = renderCardLabelModalBody(cardId);
  overlay.style.display = 'flex';
  bindCardLabelCheckboxes();
}

function bindCardLabelCheckboxes() {
  document.querySelectorAll('.card-label-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const { cardId, labelId } = checkbox.dataset;
      if (checkbox.checked) {
        await apiAssignLabel(cardId, labelId);
      } else {
        await apiUnassignLabel(cardId, labelId);
      }
    });
  });
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

async function apiCreateLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) {
      const err = await response.json();
      setStatus(`Create label failed: ${err.error}`, true);
      return false;
    }
    return true;
  } catch (error) {
    setStatus(`Create label failed: ${error.message}`, true);
    return false;
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
      const err = await response.json();
      setStatus(`Update label failed: ${err.error}`, true);
      return false;
    }
    return true;
  } catch (error) {
    setStatus(`Update label failed: ${error.message}`, true);
    return false;
  }
}

async function apiDeleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      const err = await response.json();
      setStatus(`Delete label failed: ${err.error}`, true);
      return false;
    }
    return true;
  } catch (error) {
    setStatus(`Delete label failed: ${error.message}`, true);
    return false;
  }
}

async function apiAssignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) {
      const err = await response.json();
      setStatus(`Assign label failed: ${err.error}`, true);
      return false;
    }
    return true;
  } catch (error) {
    setStatus(`Assign label failed: ${error.message}`, true);
    return false;
  }
}

async function apiUnassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
      method: 'DELETE',
    });
    if (!response.ok && response.status !== 404) {
      const err = await response.json();
      setStatus(`Unassign label failed: ${err.error}`, true);
      return false;
    }
    return true;
  } catch (error) {
    setStatus(`Unassign label failed: ${error.message}`, true);
    return false;
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
  const card = { ...message.card, labels: message.card.labels || [] };
  removeCardEverywhere(card.id);
  const target = board.columns.find((column) => column.id === card.column_id || column.id === message.columnId);
  if (!target) return;
  target.cards.push(card);
  target.cards.sort(compareCards);
  render();
  setStatus('Synced');
}

function applyLabelMutation(message) {
  switch (message.type) {
    case 'label-create': {
      // Add to labels list if not already present
      if (!labels.find((l) => l.id === message.label.id)) {
        labels.push(message.label);
        labels.sort((a, b) => a.name.localeCompare(b.name));
      }
      break;
    }
    case 'label-update': {
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
          if (card.labels) {
            for (let i = 0; i < card.labels.length; i++) {
              if (card.labels[i].id === message.label.id) {
                card.labels[i] = message.label;
              }
            }
          }
        }
      }
      break;
    }
    case 'label-delete': {
      labels = labels.filter((l) => l.id !== message.labelId);
      // Remove from active filters
      activeFilters.delete(message.labelId);
      // Remove from all cards
      for (const column of board.columns) {
        for (const card of column.cards) {
          if (card.labels) {
            card.labels = card.labels.filter((l) => l.id !== message.labelId);
          }
        }
      }
      break;
    }
    case 'card-label-assign':
    case 'card-label-unassign': {
      // Update the specific card's labels from the server response
      if (message.card) {
        const updatedCard = { ...message.card, labels: message.card.labels || [] };
        for (const column of board.columns) {
          const idx = column.cards.findIndex((c) => c.id === updatedCard.id);
          if (idx !== -1) {
            column.cards[idx] = { ...column.cards[idx], labels: updatedCard.labels };
          }
        }
      }
      break;
    }
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
  labels = await labelsRes.json();
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
