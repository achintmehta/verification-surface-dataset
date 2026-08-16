import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = []; // all known labels
let activeFilters = new Set(); // label ids currently selected for filtering
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

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
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

// ── Label helpers ─────────────────────────────────────────────────────────────

function cardMatchesFilter(card) {
  if (activeFilters.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const filterId of activeFilters) {
    if (cardLabelIds.has(filterId)) return true;
  }
  return false;
}

function contrastColor(hex) {
  // Return black or white text depending on background luminance
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? '#172033' : '#ffffff';
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

function renderLabelBar() {
  const chips = labels.map((label) => {
    const active = activeFilters.has(label.id);
    return `<button
      class="filter-chip${active ? ' active' : ''}"
      data-filter-label-id="${escapeHtml(label.id)}"
      style="background:${escapeHtml(label.color)};color:${contrastColor(label.color)};${active ? 'outline:2px solid #172033;' : ''}"
      title="Filter by ${escapeHtml(label.name)}"
    >${escapeHtml(label.name)}</button>`;
  }).join('');

  return `
    <div class="label-bar">
      <div class="label-bar-left">
        <span class="label-bar-title">Filter by label:</span>
        <div class="filter-chips">${chips || '<span class="no-labels-hint">No labels yet</span>'}</div>
        ${activeFilters.size > 0 ? '<button class="clear-filter-btn" id="clearFilterBtn">Clear filter</button>' : ''}
      </div>
      <button class="manage-labels-btn" id="manageLabelsBtnOpen">⚙ Manage Labels</button>
    </div>
  `;
}

function renderColumn(column) {
  const visibleCards = column.cards.filter(cardMatchesFilter);
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
    </section>
  `;
}

function renderCard(card) {
  const cardLabels = (card.labels || []);
  const chipsHtml = cardLabels.map((label) =>
    `<span class="label-chip" style="background:${escapeHtml(label.color)};color:${contrastColor(label.color)}">${escapeHtml(label.name)}</span>`
  ).join('');

  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${chipsHtml ? `<div class="card-labels">${chipsHtml}</div>` : ''}
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷</button>
    </article>
  `;
}

function renderLabelManager() {
  const rows = labels.map((label) => `
    <li class="lm-row" data-label-id="${escapeHtml(label.id)}">
      <span class="lm-swatch" style="background:${escapeHtml(label.color)}"></span>
      <span class="lm-name">${escapeHtml(label.name)}</span>
      <button class="lm-edit-btn" data-label-id="${escapeHtml(label.id)}" title="Edit label">✏️</button>
      <button class="lm-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete label">🗑</button>
    </li>
  `).join('');

  return `
    <div class="lm-overlay hidden" id="labelManagerOverlay">
      <div class="lm-panel" role="dialog" aria-modal="true" aria-label="Label Manager">
        <div class="lm-header">
          <h2>Label Manager</h2>
          <button class="lm-close-btn" id="manageLabelsBtnClose" title="Close">✕</button>
        </div>
        <ul class="lm-list">${rows || '<li class="lm-empty">No labels yet. Create one below.</li>'}</ul>
        <form class="lm-create-form" id="labelCreateForm">
          <h3>Create label</h3>
          <div class="lm-form-row">
            <input class="lm-name-input" name="name" type="text" maxlength="80" placeholder="Label name" required autocomplete="off" />
            <input class="lm-color-input" name="color" type="color" value="#2563eb" title="Pick a color" />
            <button type="submit" class="lm-create-btn">Create</button>
          </div>
          <div class="lm-error hidden" id="labelCreateError"></div>
        </form>
      </div>
    </div>
    <div class="lm-overlay hidden" id="labelEditOverlay">
      <div class="lm-panel" role="dialog" aria-modal="true" aria-label="Edit Label">
        <div class="lm-header">
          <h2>Edit Label</h2>
          <button class="lm-close-btn" id="labelEditClose" title="Close">✕</button>
        </div>
        <form class="lm-create-form" id="labelEditForm">
          <input type="hidden" name="id" id="labelEditId" />
          <div class="lm-form-row">
            <input class="lm-name-input" name="name" id="labelEditName" type="text" maxlength="80" placeholder="Label name" required autocomplete="off" />
            <input class="lm-color-input" name="color" id="labelEditColor" type="color" title="Pick a color" />
            <button type="submit" class="lm-create-btn">Save</button>
          </div>
          <div class="lm-error hidden" id="labelEditError"></div>
        </form>
      </div>
    </div>
    <div class="lm-overlay hidden" id="cardLabelOverlay">
      <div class="lm-panel" role="dialog" aria-modal="true" aria-label="Card Labels">
        <div class="lm-header">
          <h2>Card Labels</h2>
          <button class="lm-close-btn" id="cardLabelClose" title="Close">✕</button>
        </div>
        <div id="cardLabelBody"></div>
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
      await createCard(form.dataset.columnId, text);
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

  document.querySelectorAll('.cards').forEach((zone) => {
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      zone.classList.add('drop-target');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drop-target'));
    zone.addEventListener('drop', async (event) => {
      event.preventDefault();
      zone.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = zone.dataset.columnId;
      const { afterId, beforeId } = getDropPosition(zone, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });

  // Filter chips
  document.querySelectorAll('[data-filter-label-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.filterLabelId;
      if (activeFilters.has(id)) {
        activeFilters.delete(id);
      } else {
        activeFilters.add(id);
      }
      render();
    });
  });

  // Clear filter
  const clearBtn = document.getElementById('clearFilterBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilters.clear();
      render();
    });
  }

  // Open label manager
  const openBtn = document.getElementById('manageLabelsBtnOpen');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      document.getElementById('labelManagerOverlay').classList.remove('hidden');
    });
  }

  // Close label manager
  const closeBtn = document.getElementById('manageLabelsBtnClose');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      document.getElementById('labelManagerOverlay').classList.add('hidden');
    });
  }

  // Create label form
  const createForm = document.getElementById('labelCreateForm');
  if (createForm) {
    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
      const errEl = document.getElementById('labelCreateError');
      errEl.classList.add('hidden');
      errEl.textContent = '';
      try {
        const res = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        const data = await res.json();
        if (!res.ok) {
          errEl.textContent = data.error || 'Failed to create label';
          errEl.classList.remove('hidden');
          return;
        }
        createForm.elements.name.value = '';
        // SSE will update labels list
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    });
  }

  // Edit label buttons
  document.querySelectorAll('.lm-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const labelId = btn.dataset.labelId;
      const label = labels.find((l) => l.id === labelId);
      if (!label) return;
      document.getElementById('labelEditId').value = label.id;
      document.getElementById('labelEditName').value = label.name;
      document.getElementById('labelEditColor').value = label.color;
      document.getElementById('labelEditError').classList.add('hidden');
      document.getElementById('labelEditOverlay').classList.remove('hidden');
    });
  });

  // Close edit overlay
  const editClose = document.getElementById('labelEditClose');
  if (editClose) {
    editClose.addEventListener('click', () => {
      document.getElementById('labelEditOverlay').classList.add('hidden');
    });
  }

  // Edit label form submit
  const editForm = document.getElementById('labelEditForm');
  if (editForm) {
    editForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = editForm.elements.id.value;
      const name = editForm.elements.name.value.trim();
      const color = editForm.elements.color.value;
      const errEl = document.getElementById('labelEditError');
      errEl.classList.add('hidden');
      errEl.textContent = '';
      try {
        const res = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        const data = await res.json();
        if (!res.ok) {
          errEl.textContent = data.error || 'Failed to update label';
          errEl.classList.remove('hidden');
          return;
        }
        document.getElementById('labelEditOverlay').classList.add('hidden');
        // SSE will update
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    });
  }

  // Delete label buttons
  document.querySelectorAll('.lm-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const label = labels.find((l) => l.id === labelId);
      if (!label) return;
      if (!confirm(`Delete label "${label.name}"? This will remove it from all cards.`)) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = await res.json();
          alert(data.error || 'Failed to delete label');
        }
        // SSE will update
      } catch (err) {
        alert(err.message);
      }
    });
  });

  // Card label buttons
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      openCardLabelPanel(cardId);
    });
  });

  // Close card label overlay
  const cardLabelClose = document.getElementById('cardLabelClose');
  if (cardLabelClose) {
    cardLabelClose.addEventListener('click', () => {
      document.getElementById('cardLabelOverlay').classList.add('hidden');
    });
  }

  // Close overlays on backdrop click
  document.querySelectorAll('.lm-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });
}

function openCardLabelPanel(cardId) {
  const found = findCard(cardId);
  if (!found) return;
  const card = found.card;
  const assignedIds = new Set((card.labels || []).map((l) => l.id));

  const body = document.getElementById('cardLabelBody');
  if (!body) return;

  function renderCardLabelBody() {
    if (labels.length === 0) {
      body.innerHTML = '<p class="lm-empty">No labels exist yet. Create some in the Label Manager.</p>';
      return;
    }
    body.innerHTML = `
      <ul class="lm-list">
        ${labels.map((label) => {
          const assigned = assignedIds.has(label.id);
          return `<li class="lm-row">
            <span class="lm-swatch" style="background:${escapeHtml(label.color)}"></span>
            <span class="lm-name">${escapeHtml(label.name)}</span>
            <button
              class="lm-assign-btn${assigned ? ' assigned' : ''}"
              data-card-id="${escapeHtml(cardId)}"
              data-label-id="${escapeHtml(label.id)}"
              data-assigned="${assigned ? '1' : '0'}"
            >${assigned ? '✓ Remove' : '+ Add'}</button>
          </li>`;
        }).join('')}
      </ul>
    `;

    body.querySelectorAll('.lm-assign-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const cId = btn.dataset.cardId;
        const lId = btn.dataset.labelId;
        const isAssigned = btn.dataset.assigned === '1';
        btn.disabled = true;
        try {
          if (isAssigned) {
            await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cId)}/labels/${encodeURIComponent(lId)}`, { method: 'DELETE' });
            assignedIds.delete(lId);
          } else {
            await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cId)}/labels`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ labelId: lId }),
            });
            assignedIds.add(lId);
          }
          // SSE will update board; re-render the panel body optimistically
          renderCardLabelBody();
        } catch (err) {
          btn.disabled = false;
          alert(err.message);
        }
      });
    });
  }

  renderCardLabelBody();
  document.getElementById('cardLabelOverlay').classList.remove('hidden');
}

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
  // Always sync from the board payload when present
  if (message.board) {
    board = normalizeBoard(message.board);
  }

  switch (message.type) {
    case 'label-create':
      if (message.label && !labels.find((l) => l.id === message.label.id)) {
        labels.push(message.label);
        labels.sort((a, b) => a.name.localeCompare(b.name));
      }
      break;
    case 'label-update':
      if (message.label) {
        const idx = labels.findIndex((l) => l.id === message.label.id);
        if (idx !== -1) labels[idx] = message.label;
        else labels.push(message.label);
        labels.sort((a, b) => a.name.localeCompare(b.name));
      }
      break;
    case 'label-delete':
      if (message.labelId) {
        labels = labels.filter((l) => l.id !== message.labelId);
        activeFilters.delete(message.labelId);
      }
      break;
    case 'card-label-assign':
    case 'card-label-unassign':
      // board already synced above
      break;
  }

  render();
  setStatus('Synced');
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
