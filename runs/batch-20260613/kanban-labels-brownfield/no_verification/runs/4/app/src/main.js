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

// Returns true if the card passes the current label filter
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
        <button class="btn-label-manager" id="open-label-manager" title="Manage labels">🏷 Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${renderLabelManagerModal()}
  `;
  bindEvents();
}

function renderFilterBar() {
  if (allLabels.length === 0) return '';
  return `
    <div class="filter-bar">
      <span class="filter-label">Filter:</span>
      ${allLabels
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
          ? `<button class="filter-clear" id="clear-filters">✕ Clear</button>`
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
  const labels = card.labels || [];
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${
        labels.length > 0
          ? `<div class="card-labels">${labels.map(renderLabelChip).join('')}</div>`
          : ''
      }
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels for this card">🏷</button>
    </article>
  `;
}

function renderLabelChip(label) {
  return `<span class="label-chip" style="background:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`;
}

// ── Label Manager Modal ───────────────────────────────────────────────────────

function renderLabelManagerModal() {
  return `
    <div class="modal-overlay hidden" id="label-manager-overlay">
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
              maxlength="100"
              placeholder="Label name…"
              autocomplete="off"
              required
            />
            <input type="color" name="color" value="#3b82f6" title="Pick a color" />
            <button type="submit">Create</button>
          </form>
          <div id="label-create-error" class="form-error hidden"></div>
          <ul class="label-list" id="label-list">
            ${allLabels.map(renderLabelListItem).join('')}
          </ul>
        </div>
      </div>
    </div>
  `;
}

function renderLabelListItem(label) {
  return `
    <li class="label-list-item" data-label-id="${escapeHtml(label.id)}">
      <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
      <span class="label-name-display">${escapeHtml(label.name)}</span>
      <div class="label-actions">
        <button class="btn-edit-label" data-label-id="${escapeHtml(label.id)}" title="Edit label">✏️</button>
        <button class="btn-delete-label" data-label-id="${escapeHtml(label.id)}" title="Delete label">🗑</button>
      </div>
    </li>
  `;
}

// ── Card Label Assignment Modal ───────────────────────────────────────────────

function renderCardLabelModal(card) {
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  return `
    <div class="modal-overlay" id="card-label-overlay">
      <div class="modal" id="card-label-modal" role="dialog" aria-modal="true" aria-label="Assign Labels">
        <div class="modal-header">
          <h2>Labels for card</h2>
          <button class="modal-close" id="close-card-label-modal" aria-label="Close">✕</button>
        </div>
        <div class="modal-body">
          <p class="card-label-card-text">${escapeHtml(card.text)}</p>
          ${
            allLabels.length === 0
              ? '<p class="no-labels-hint">No labels yet. Create some in the Label Manager.</p>'
              : `<ul class="card-label-list">
                ${allLabels
                  .map(
                    (label) => `
                  <li class="card-label-list-item">
                    <label class="card-label-toggle">
                      <input
                        type="checkbox"
                        data-card-id="${escapeHtml(card.id)}"
                        data-label-id="${escapeHtml(label.id)}"
                        ${cardLabelIds.has(label.id) ? 'checked' : ''}
                      />
                      <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
                      <span>${escapeHtml(label.name)}</span>
                    </label>
                  </li>
                `
                  )
                  .join('')}
              </ul>`
          }
        </div>
      </div>
    </div>
  `;
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
      const columnId = form.dataset.columnId;
      await createCard(columnId, text);
    });
  });

  // Drag-and-drop
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

  const clearFiltersBtn = document.getElementById('clear-filters');
  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener('click', () => {
      activeFilters.clear();
      render();
    });
  }

  // Label manager open/close
  const openBtn = document.getElementById('open-label-manager');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      document.getElementById('label-manager-overlay').classList.remove('hidden');
    });
  }

  const closeBtn = document.getElementById('close-label-manager');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      document.getElementById('label-manager-overlay').classList.add('hidden');
    });
  }

  const overlay = document.getElementById('label-manager-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  }

  // Label create form
  const createForm = document.getElementById('label-create-form');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
      const errorEl = document.getElementById('label-create-error');
      errorEl.classList.add('hidden');
      errorEl.textContent = '';
      if (!name) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!res.ok) {
          const data = await res.json();
          errorEl.textContent = data.error || 'Failed to create label';
          errorEl.classList.remove('hidden');
          return;
        }
        createForm.elements.name.value = '';
        // SSE will update allLabels and re-render
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.classList.remove('hidden');
      }
    });
  }

  // Label edit buttons
  document.querySelectorAll('.btn-edit-label').forEach((btn) => {
    btn.addEventListener('click', () => {
      const labelId = btn.dataset.labelId;
      openEditLabelInline(labelId);
    });
  });

  // Label delete buttons
  document.querySelectorAll('.btn-delete-label').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const label = allLabels.find((l) => l.id === labelId);
      if (!label) return;
      if (!confirm(`Delete label "${label.name}"? This will remove it from all cards.`)) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 404) {
          const data = await res.json().catch(() => ({}));
          setStatus(`Delete failed: ${data.error || res.statusText}`, true);
        }
        // SSE will update
      } catch (err) {
        setStatus(`Delete failed: ${err.message}`, true);
      }
    });
  });

  // Card label buttons
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      openCardLabelModal(cardId);
    });
  });
}

// ── Inline label editing ──────────────────────────────────────────────────────

function openEditLabelInline(labelId) {
  const label = allLabels.find((l) => l.id === labelId);
  if (!label) return;
  const li = document.querySelector(`.label-list-item[data-label-id="${labelId}"]`);
  if (!li) return;

  li.innerHTML = `
    <form class="label-edit-form" data-label-id="${escapeHtml(labelId)}">
      <input type="color" name="color" value="${escapeHtml(label.color)}" title="Pick a color" />
      <input type="text" name="name" value="${escapeHtml(label.name)}" maxlength="100" required autocomplete="off" />
      <button type="submit">Save</button>
      <button type="button" class="btn-cancel-edit">Cancel</button>
    </form>
    <div class="label-edit-error hidden"></div>
  `;

  const form = li.querySelector('.label-edit-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newName = form.elements.name.value.trim();
    const newColor = form.elements.color.value;
    const errorEl = li.querySelector('.label-edit-error');
    errorEl.classList.add('hidden');
    if (!newName) return;
    try {
      const res = await fetch(`${API_BASE}/api/labels/${labelId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, color: newColor }),
      });
      if (!res.ok) {
        const data = await res.json();
        errorEl.textContent = data.error || 'Failed to update label';
        errorEl.classList.remove('hidden');
        return;
      }
      // SSE will re-render
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  });

  li.querySelector('.btn-cancel-edit').addEventListener('click', () => {
    li.innerHTML = renderLabelListItem(label).replace(/^\s*<li[^>]*>|<\/li>\s*$/g, '');
    // Re-render the item properly
    const newLi = document.createElement('li');
    newLi.className = 'label-list-item';
    newLi.dataset.labelId = labelId;
    newLi.innerHTML = `
      <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
      <span class="label-name-display">${escapeHtml(label.name)}</span>
      <div class="label-actions">
        <button class="btn-edit-label" data-label-id="${escapeHtml(label.id)}" title="Edit label">✏️</button>
        <button class="btn-delete-label" data-label-id="${escapeHtml(label.id)}" title="Delete label">🗑</button>
      </div>
    `;
    li.replaceWith(newLi);
    // Re-bind the new buttons
    newLi.querySelector('.btn-edit-label').addEventListener('click', () => openEditLabelInline(labelId));
    newLi.querySelector('.btn-delete-label').addEventListener('click', async () => {
      if (!confirm(`Delete label "${label.name}"? This will remove it from all cards.`)) return;
      try {
        await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
      } catch (err) {
        setStatus(`Delete failed: ${err.message}`, true);
      }
    });
  });
}

// ── Card label assignment modal ───────────────────────────────────────────────

function openCardLabelModal(cardId) {
  const found = findCard(cardId);
  if (!found) return;
  const card = found.card;

  // Remove any existing modal
  document.getElementById('card-label-overlay')?.remove();

  const wrapper = document.createElement('div');
  wrapper.innerHTML = renderCardLabelModal(card);
  document.body.appendChild(wrapper.firstElementChild);

  const modalOverlay = document.getElementById('card-label-overlay');

  document.getElementById('close-card-label-modal').addEventListener('click', () => {
    modalOverlay.remove();
  });

  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) modalOverlay.remove();
  });

  modalOverlay.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const cId = checkbox.dataset.cardId;
      const lId = checkbox.dataset.labelId;
      if (checkbox.checked) {
        await fetch(`${API_BASE}/api/cards/${cId}/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labelId: lId }),
        });
      } else {
        await fetch(`${API_BASE}/api/cards/${cId}/labels/${lId}`, { method: 'DELETE' });
      }
      // SSE will update the board; update the modal's card reference
    });
  });
}

// ── Drag-and-drop helpers ─────────────────────────────────────────────────────

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
    // Reload to recover
    await loadBoard();
    render();
  }
}

// ── SSE / mutation application ────────────────────────────────────────────────

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
  switch (message.type) {
    case 'label-create': {
      // Add to allLabels if not already present
      if (!allLabels.find((l) => l.id === message.label.id)) {
        allLabels.push(message.label);
        allLabels.sort((a, b) => a.name.localeCompare(b.name));
      }
      break;
    }
    case 'label-update': {
      const idx = allLabels.findIndex((l) => l.id === message.label.id);
      if (idx !== -1) {
        allLabels[idx] = message.label;
      } else {
        allLabels.push(message.label);
      }
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
      // Update label data on all cards
      for (const column of board.columns) {
        for (const card of column.cards) {
          card.labels = (card.labels || []).map((l) =>
            l.id === message.label.id ? message.label : l
          );
        }
      }
      break;
    }
    case 'label-delete': {
      allLabels = allLabels.filter((l) => l.id !== message.labelId);
      activeFilters.delete(message.labelId);
      // Remove label from all cards
      for (const column of board.columns) {
        for (const card of column.cards) {
          card.labels = (card.labels || []).filter((l) => l.id !== message.labelId);
        }
      }
      break;
    }
    case 'card-label-assign':
    case 'card-label-unassign': {
      if (message.card) {
        // Update the card in our local board state
        for (const column of board.columns) {
          const idx = column.cards.findIndex((c) => c.id === message.card.id);
          if (idx !== -1) {
            column.cards[idx] = { ...column.cards[idx], labels: message.card.labels || [] };
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
  allLabels = await labelsRes.json();
  allLabels.sort((a, b) => a.name.localeCompare(b.name));
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
    render();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
