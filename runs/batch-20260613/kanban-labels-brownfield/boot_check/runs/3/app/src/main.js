import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];          // full label list from server
let activeFilters = new Set(); // label ids currently selected for filtering
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

// ── Utilities ──────────────────────────────────────────────────────────────────

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

// ── Filtering ──────────────────────────────────────────────────────────────────

function cardMatchesFilter(card) {
  if (activeFilters.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const filterId of activeFilters) {
    if (cardLabelIds.has(filterId)) return true;
  }
  return false;
}

// ── Render ─────────────────────────────────────────────────────────────────────

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
    ${renderLabelManagerModal()}
  `;
  bindEvents();
}

function renderLabelBar() {
  const filterChips = allLabels.map((label) => {
    const active = activeFilters.has(label.id);
    return `<button
      class="filter-chip${active ? ' active' : ''}"
      data-filter-label-id="${escapeHtml(label.id)}"
      style="--chip-color:${escapeHtml(label.color)}"
      title="Filter by ${escapeHtml(label.name)}"
    >${escapeHtml(label.name)}</button>`;
  }).join('');

  const clearBtn = activeFilters.size > 0
    ? `<button class="filter-clear" id="filter-clear-btn">Clear filter</button>`
    : '';

  return `
    <div class="label-bar">
      <div class="label-bar-filters">
        <span class="label-bar-title">Filter:</span>
        ${filterChips || '<span class="label-bar-empty">No labels yet</span>'}
        ${clearBtn}
      </div>
      <button class="manage-labels-btn" id="open-label-manager">Manage Labels</button>
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
        ${column.cards.map((card) => renderCard(card)).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const hidden = !cardMatchesFilter(card);
  const labelsHtml = (card.labels || []).map((label) => `
    <span class="label-chip" style="background:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>
  `).join('');

  return `
    <article
      class="card${hidden ? ' card-hidden' : ''}"
      draggable="${hidden ? 'false' : 'true'}"
      data-card-id="${escapeHtml(card.id)}"
      title="Drag to move"
    >
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml ? `<div class="card-labels">${labelsHtml}</div>` : ''}
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷</button>
    </article>
  `;
}

// ── Label Manager Modal ────────────────────────────────────────────────────────

function renderLabelManagerModal() {
  return `
    <div class="modal-overlay" id="label-manager-overlay" style="display:none">
      <div class="modal" id="label-manager-modal">
        <div class="modal-header">
          <h2>Manage Labels</h2>
          <button class="modal-close" id="close-label-manager">✕</button>
        </div>
        <div class="modal-body">
          <form class="create-label-form" id="create-label-form">
            <input name="name" type="text" maxlength="50" placeholder="Label name…" autocomplete="off" required />
            <input name="color" type="color" value="#2563eb" title="Pick a color" />
            <button type="submit">Create</button>
          </form>
          <ul class="label-list" id="label-list">
            ${allLabels.map(renderLabelItem).join('')}
          </ul>
        </div>
      </div>
    </div>
  `;
}

function renderLabelItem(label) {
  return `
    <li class="label-item" data-label-id="${escapeHtml(label.id)}">
      <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
      <input
        class="label-name-input"
        type="text"
        value="${escapeHtml(label.name)}"
        maxlength="50"
        data-label-id="${escapeHtml(label.id)}"
        data-original-name="${escapeHtml(label.name)}"
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
  `;
}

// ── Card Label Assignment Modal ────────────────────────────────────────────────

function openCardLabelModal(cardId) {
  const found = findCard(cardId);
  if (!found) return;
  const card = found.card;

  // Remove any existing card-label modal
  document.getElementById('card-label-overlay')?.remove();

  const assignedIds = new Set((card.labels || []).map((l) => l.id));

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'card-label-overlay';

  const labelItems = allLabels.map((label) => {
    const checked = assignedIds.has(label.id);
    return `
      <li class="card-label-item">
        <label>
          <input
            type="checkbox"
            class="card-label-checkbox"
            data-card-id="${escapeHtml(cardId)}"
            data-label-id="${escapeHtml(label.id)}"
            ${checked ? 'checked' : ''}
          />
          <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
          ${escapeHtml(label.name)}
        </label>
      </li>
    `;
  }).join('');

  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2>Labels for card</h2>
        <button class="modal-close" id="close-card-label-modal">✕</button>
      </div>
      <div class="modal-body">
        ${allLabels.length === 0
          ? '<p class="label-bar-empty">No labels yet. Create some in Manage Labels.</p>'
          : `<ul class="label-list">${labelItems}</ul>`
        }
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.style.display = 'flex';

  overlay.querySelector('#close-card-label-modal')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelectorAll('.card-label-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('change', async (e) => {
      const cId = e.target.dataset.cardId;
      const lId = e.target.dataset.labelId;
      if (e.target.checked) {
        await assignLabel(cId, lId);
      } else {
        await unassignLabel(cId, lId);
      }
    });
  });
}

// ── Event Binding ──────────────────────────────────────────────────────────────

function bindEvents() {
  // Add card forms
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

  // Drag and drop
  document.querySelectorAll('.card:not(.card-hidden)').forEach((el) => {
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

  document.querySelectorAll('.cards').forEach((container) => {
    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      container.classList.add('drop-target');
    });
    container.addEventListener('dragleave', (e) => {
      if (!container.contains(e.relatedTarget)) container.classList.remove('drop-target');
    });
    container.addEventListener('drop', async (e) => {
      e.preventDefault();
      container.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = container.dataset.columnId;
      const { afterId, beforeId } = getDropNeighbors(container, draggedCardId);
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
  document.getElementById('filter-clear-btn')?.addEventListener('click', () => {
    activeFilters.clear();
    render();
  });

  // Open label manager
  document.getElementById('open-label-manager')?.addEventListener('click', () => {
    document.getElementById('label-manager-overlay').style.display = 'flex';
  });

  // Close label manager
  document.getElementById('close-label-manager')?.addEventListener('click', () => {
    document.getElementById('label-manager-overlay').style.display = 'none';
  });

  document.getElementById('label-manager-overlay')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('label-manager-overlay')) {
      document.getElementById('label-manager-overlay').style.display = 'none';
    }
  });

  // Create label form
  document.getElementById('create-label-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const response = await fetch(`${API_BASE}/api/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color }),
      });
      if (!response.ok) {
        const err = await response.json();
        setStatus(`Create label failed: ${err.error}`, true);
      } else {
        form.elements.name.value = '';
      }
    } catch (error) {
      setStatus(`Create label failed: ${error.message}`, true);
    } finally {
      btn.disabled = false;
    }
  });

  // Label save buttons
  document.querySelectorAll('.label-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const li = btn.closest('.label-item');
      const nameInput = li.querySelector('.label-name-input');
      const colorInput = li.querySelector('.label-color-input');
      const name = nameInput.value.trim();
      const color = colorInput.value;
      if (!name) { setStatus('Label name cannot be empty', true); return; }
      btn.disabled = true;
      try {
        const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!response.ok) {
          const err = await response.json();
          setStatus(`Update label failed: ${err.error}`, true);
        }
      } catch (error) {
        setStatus(`Update label failed: ${error.message}`, true);
      } finally {
        btn.disabled = false;
      }
    });
  });

  // Label color inputs — update swatch live
  document.querySelectorAll('.label-color-input').forEach((input) => {
    input.addEventListener('input', () => {
      const li = input.closest('.label-item');
      const swatch = li.querySelector('.label-swatch');
      if (swatch) swatch.style.background = input.value;
    });
  });

  // Label delete buttons
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      if (!confirm('Delete this label? It will be removed from all cards.')) return;
      btn.disabled = true;
      try {
        const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, {
          method: 'DELETE',
        });
        if (!response.ok && response.status !== 204) {
          const err = await response.json();
          setStatus(`Delete label failed: ${err.error}`, true);
          btn.disabled = false;
        } else {
          // Remove from active filters if present
          activeFilters.delete(labelId);
        }
      } catch (error) {
        setStatus(`Delete label failed: ${error.message}`, true);
        btn.disabled = false;
      }
    });
  });

  // Card label buttons
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCardLabelModal(btn.dataset.cardId);
    });
  });
}

// ── Drag helpers ───────────────────────────────────────────────────────────────

function getDropNeighbors(list, cardId) {
  const ids = [...list.querySelectorAll('.card:not(.card-hidden)')].map((el) => el.dataset.cardId);
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

// ── API calls ──────────────────────────────────────────────────────────────────

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
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Assign failed');
  } catch (error) {
    setStatus(`Assign label failed: ${error.message}`, true);
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
    setStatus(`Unassign label failed: ${error.message}`, true);
  }
}

// ── SSE / mutation handling ────────────────────────────────────────────────────

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
  // Always sync board if provided (covers card label changes)
  if (message.board) {
    board = normalizeBoard(message.board);
  }

  // Sync label list
  if (message.type === 'label-create' && message.label) {
    const exists = allLabels.find((l) => l.id === message.label.id);
    if (!exists) allLabels.push(message.label);
    allLabels.sort((a, b) => a.name.localeCompare(b.name));
  } else if (message.type === 'label-update' && message.label) {
    const idx = allLabels.findIndex((l) => l.id === message.label.id);
    if (idx !== -1) allLabels[idx] = message.label;
    else allLabels.push(message.label);
    allLabels.sort((a, b) => a.name.localeCompare(b.name));
  } else if (message.type === 'label-delete' && message.labelId) {
    allLabels = allLabels.filter((l) => l.id !== message.labelId);
    activeFilters.delete(message.labelId);
  }

  render();
  setStatus('Synced');

  // Re-open card label modal if it was open, with updated data
  const cardLabelOverlay = document.getElementById('card-label-overlay');
  if (cardLabelOverlay) {
    const checkbox = cardLabelOverlay.querySelector('.card-label-checkbox');
    if (checkbox) {
      openCardLabelModal(checkbox.dataset.cardId);
    }
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
