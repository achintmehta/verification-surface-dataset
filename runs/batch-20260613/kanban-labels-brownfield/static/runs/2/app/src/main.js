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
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <button id="lm-open-btn" class="lm-open-btn" title="Manage labels">🏷 Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
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
  if (labels.length === 0) return '';
  const chips = labels
    .map((label) => {
      const active = activeFilters.has(label.id);
      return `<button
        class="filter-chip${active ? ' active' : ''}"
        data-filter-label-id="${escapeHtml(label.id)}"
        style="--chip-color:${escapeHtml(label.color)}"
        title="${active ? 'Remove filter' : 'Filter by'} ${escapeHtml(label.name)}"
      >${escapeHtml(label.name)}</button>`;
    })
    .join('');
  const clearBtn =
    activeFilters.size > 0
      ? `<button class="filter-clear" id="filter-clear">Clear filter</button>`
      : '';
  return `<div class="filter-bar"><span class="filter-label">Filter:</span>${chips}${clearBtn}</div>`;
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
      ${hiddenNote}
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${visibleCards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const labelChips = (card.labels || [])
    .map(
      (label) =>
        `<span class="label-chip" style="background:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`
    )
    .join('');
  const labelsHtml = labelChips
    ? `<div class="card-labels">${labelChips}</div>`
    : '';
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml}
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷</button>
    </article>
  `;
}

function renderLabelManager() {
  return `
    <div id="label-manager-overlay" class="lm-overlay hidden" role="dialog" aria-modal="true" aria-label="Label manager">
      <div class="lm-panel">
        <div class="lm-header">
          <h2>Labels</h2>
          <button id="lm-close" class="lm-close" aria-label="Close">✕</button>
        </div>
        <ul class="lm-list" id="lm-list">
          ${labels.map(renderLabelRow).join('')}
        </ul>
        <form class="lm-create-form" id="lm-create-form">
          <input
            id="lm-new-name"
            type="text"
            maxlength="50"
            placeholder="Label name…"
            autocomplete="off"
            required
          />
          <input id="lm-new-color" type="color" value="#2563eb" title="Pick a color" />
          <button type="submit">Create</button>
        </form>
        <p class="lm-error hidden" id="lm-error"></p>
      </div>
    </div>
    <div id="card-label-overlay" class="lm-overlay hidden" role="dialog" aria-modal="true" aria-label="Assign labels">
      <div class="lm-panel">
        <div class="lm-header">
          <h2>Assign Labels</h2>
          <button id="cl-close" class="lm-close" aria-label="Close">✕</button>
        </div>
        <ul class="cl-list" id="cl-list"></ul>
        <p class="lm-error hidden" id="cl-error"></p>
      </div>
    </div>
  `;
}

function renderLabelRow(label) {
  return `
    <li class="lm-row" data-label-id="${escapeHtml(label.id)}">
      <span class="lm-swatch" style="background:${escapeHtml(label.color)}"></span>
      <span class="lm-name" data-label-id="${escapeHtml(label.id)}">${escapeHtml(label.name)}</span>
      <input class="lm-edit-name hidden" type="text" maxlength="50" value="${escapeHtml(label.name)}" data-label-id="${escapeHtml(label.id)}" />
      <input class="lm-edit-color hidden" type="color" value="${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}" />
      <button class="lm-btn lm-edit-btn" data-label-id="${escapeHtml(label.id)}" title="Edit">✏️</button>
      <button class="lm-btn lm-save-btn hidden" data-label-id="${escapeHtml(label.id)}" title="Save">💾</button>
      <button class="lm-btn lm-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete">🗑</button>
    </li>
  `;
}

// ── Label manager open/close ──────────────────────────────────────────────────

let labelManagerOpen = false;
let cardLabelTargetId = null; // card id for the assign-labels dialog

function openLabelManager() {
  labelManagerOpen = true;
  const overlay = document.getElementById('label-manager-overlay');
  if (overlay) overlay.classList.remove('hidden');
}

function closeLabelManager() {
  labelManagerOpen = false;
  const overlay = document.getElementById('label-manager-overlay');
  if (overlay) overlay.classList.add('hidden');
  const err = document.getElementById('lm-error');
  if (err) { err.textContent = ''; err.classList.add('hidden'); }
}

function openCardLabelDialog(cardId) {
  cardLabelTargetId = cardId;
  refreshCardLabelList();
  const overlay = document.getElementById('card-label-overlay');
  if (overlay) overlay.classList.remove('hidden');
}

function closeCardLabelDialog() {
  cardLabelTargetId = null;
  const overlay = document.getElementById('card-label-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function refreshCardLabelList() {
  const list = document.getElementById('cl-list');
  if (!list || !cardLabelTargetId) return;
  const found = findCard(cardLabelTargetId);
  const cardLabels = found ? (found.card.labels || []) : [];
  const cardLabelIds = new Set(cardLabels.map((l) => l.id));

  list.innerHTML = labels
    .map((label) => {
      const assigned = cardLabelIds.has(label.id);
      return `
        <li class="cl-row">
          <span class="lm-swatch" style="background:${escapeHtml(label.color)}"></span>
          <span class="cl-name">${escapeHtml(label.name)}</span>
          <button
            class="lm-btn cl-toggle-btn"
            data-card-id="${escapeHtml(cardLabelTargetId)}"
            data-label-id="${escapeHtml(label.id)}"
            data-assigned="${assigned}"
            title="${assigned ? 'Remove label' : 'Add label'}"
          >${assigned ? '✓ Remove' : '+ Add'}</button>
        </li>
      `;
    })
    .join('');

  if (labels.length === 0) {
    list.innerHTML = '<li class="cl-empty">No labels yet. Create some in the label manager.</li>';
  }

  // Bind toggle buttons
  list.querySelectorAll('.cl-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const cid = btn.dataset.cardId;
      const lid = btn.dataset.labelId;
      const assigned = btn.dataset.assigned === 'true';
      const errEl = document.getElementById('cl-error');
      try {
        if (assigned) {
          await fetch(`${API_BASE}/api/cards/${cid}/labels/${lid}`, { method: 'DELETE' });
        } else {
          await fetch(`${API_BASE}/api/cards/${cid}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId: lid }),
          });
        }
        if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
      } catch (err) {
        if (errEl) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
      }
    });
  });
}

// ── Event binding ─────────────────────────────────────────────────────────────

function bindEvents() {
  // ── Add-card forms ──
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

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      list.classList.add('drop-target');
    });
    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) list.classList.remove('drop-target');
    });
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
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

  // ── Filter bar ──
  document.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lid = btn.dataset.filterLabelId;
      if (activeFilters.has(lid)) {
        activeFilters.delete(lid);
      } else {
        activeFilters.add(lid);
      }
      render();
    });
  });

  const clearBtn = document.getElementById('filter-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilters.clear();
      render();
    });
  }

  // ── Label manager open button (in topbar) ──
  const lmOpenBtn = document.getElementById('lm-open-btn');
  if (lmOpenBtn) {
    lmOpenBtn.addEventListener('click', openLabelManager);
  }

  // ── Label manager close ──
  const lmClose = document.getElementById('lm-close');
  if (lmClose) lmClose.addEventListener('click', closeLabelManager);

  const lmOverlay = document.getElementById('label-manager-overlay');
  if (lmOverlay) {
    lmOverlay.addEventListener('click', (e) => {
      if (e.target === lmOverlay) closeLabelManager();
    });
  }

  // ── Label manager create form ──
  const lmCreateForm = document.getElementById('lm-create-form');
  if (lmCreateForm) {
    lmCreateForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('lm-new-name');
      const colorInput = document.getElementById('lm-new-color');
      const errEl = document.getElementById('lm-error');
      const name = nameInput.value.trim();
      const color = colorInput.value;
      if (!name) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!resp.ok) {
          const body = await resp.json();
          if (errEl) { errEl.textContent = body.error || 'Error'; errEl.classList.remove('hidden'); }
          return;
        }
        nameInput.value = '';
        if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
      } catch (err) {
        if (errEl) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
      }
    });
  }

  // ── Label manager edit / save / delete ──
  const lmList = document.getElementById('lm-list');
  if (lmList) {
    lmList.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const labelId = btn.dataset.labelId;
      const row = lmList.querySelector(`li[data-label-id="${labelId}"]`);
      if (!row) return;
      const errEl = document.getElementById('lm-error');

      if (btn.classList.contains('lm-edit-btn')) {
        // Switch to edit mode
        row.querySelector('.lm-name').classList.add('hidden');
        row.querySelector('.lm-edit-name').classList.remove('hidden');
        row.querySelector('.lm-edit-color').classList.remove('hidden');
        row.querySelector('.lm-edit-btn').classList.add('hidden');
        row.querySelector('.lm-save-btn').classList.remove('hidden');
        row.querySelector('.lm-edit-name').focus();
      } else if (btn.classList.contains('lm-save-btn')) {
        const nameInput = row.querySelector('.lm-edit-name');
        const colorInput = row.querySelector('.lm-edit-color');
        const name = nameInput.value.trim();
        const color = colorInput.value;
        if (!name) return;
        try {
          const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, color }),
          });
          if (!resp.ok) {
            const body = await resp.json();
            if (errEl) { errEl.textContent = body.error || 'Error'; errEl.classList.remove('hidden'); }
            return;
          }
          if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
        } catch (err) {
          if (errEl) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
        }
      } else if (btn.classList.contains('lm-delete-btn')) {
        if (!confirm(`Delete label "${row.querySelector('.lm-name').textContent}"?`)) return;
        try {
          const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
          if (!resp.ok && resp.status !== 204) {
            const body = await resp.json();
            if (errEl) { errEl.textContent = body.error || 'Error'; errEl.classList.remove('hidden'); }
          }
          if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
        } catch (err) {
          if (errEl) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
        }
      }
    });
  }

  // ── Card label assign buttons ──
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCardLabelDialog(btn.dataset.cardId);
    });
  });

  // ── Card label dialog close ──
  const clClose = document.getElementById('cl-close');
  if (clClose) clClose.addEventListener('click', closeCardLabelDialog);

  const clOverlay = document.getElementById('card-label-overlay');
  if (clOverlay) {
    clOverlay.addEventListener('click', (e) => {
      if (e.target === clOverlay) closeCardLabelDialog();
    });
  }

  // Re-open dialogs if they were open before re-render
  if (labelManagerOpen) openLabelManager();
  if (cardLabelTargetId) openCardLabelDialog(cardLabelTargetId);
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


// ── SSE / board state ─────────────────────────────────────────────────────────

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
  // All label mutations carry the full board; just replace and re-render.
  if (message.board) {
    board = normalizeBoard(message.board);
  }

  // Keep local labels list in sync
  if (message.type === 'label-create' && message.label) {
    if (!labels.find((l) => l.id === message.label.id)) {
      labels.push(message.label);
      labels.sort((a, b) => a.name.localeCompare(b.name));
    }
  } else if (message.type === 'label-update' && message.label) {
    const idx = labels.findIndex((l) => l.id === message.label.id);
    if (idx !== -1) labels[idx] = message.label;
    else labels.push(message.label);
    labels.sort((a, b) => a.name.localeCompare(b.name));
  } else if (message.type === 'label-delete' && message.labelId) {
    labels = labels.filter((l) => l.id !== message.labelId);
    activeFilters.delete(message.labelId);
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
