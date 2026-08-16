import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = []; // all known labels
let activeFilters = new Set(); // label ids currently selected for filtering
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

// ── utilities ─────────────────────────────────────────────────────────────────

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

// ── filter helpers ────────────────────────────────────────────────────────────

function cardMatchesFilter(card) {
  if (activeFilters.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const filterId of activeFilters) {
    if (cardLabelIds.has(filterId)) return true;
  }
  return false;
}

// ── render ────────────────────────────────────────────────────────────────────

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
    <div id="label-manager-overlay" class="overlay hidden"></div>
    <div id="label-manager" class="label-manager hidden"></div>
    <div id="card-label-overlay" class="overlay hidden"></div>
    <div id="card-label-panel" class="card-label-panel hidden"></div>
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
          (l) => `
        <button
          class="filter-chip${activeFilters.has(l.id) ? ' active' : ''}"
          data-filter-id="${escapeHtml(l.id)}"
          style="--chip-color: ${escapeHtml(l.color)}"
        >${escapeHtml(l.name)}</button>
      `
        )
        .join('')}
      ${
        activeFilters.size > 0
          ? `<button class="filter-clear" id="filter-clear">✕ Clear</button>`
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
        ${hiddenCount > 0 ? `<div class="hidden-cards-note">${hiddenCount} card${hiddenCount > 1 ? 's' : ''} hidden by filter</div>` : ''}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const labelChips =
    (card.labels || []).length > 0
      ? `<div class="card-labels">${(card.labels || [])
          .map(
            (l) =>
              `<span class="label-chip" style="background:${escapeHtml(l.color)}" title="${escapeHtml(l.name)}">${escapeHtml(l.name)}</span>`
          )
          .join('')}</div>`
      : '';
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelChips}
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷</button>
    </article>
  `;
}

// ── label manager modal ───────────────────────────────────────────────────────

function openLabelManager() {
  const overlay = document.getElementById('label-manager-overlay');
  const panel = document.getElementById('label-manager');
  overlay.classList.remove('hidden');
  panel.classList.remove('hidden');
  renderLabelManager();
}

function closeLabelManager() {
  document.getElementById('label-manager-overlay').classList.add('hidden');
  document.getElementById('label-manager').classList.add('hidden');
}

function renderLabelManager() {
  const panel = document.getElementById('label-manager');
  panel.innerHTML = `
    <div class="modal-header">
      <h2>Label Manager</h2>
      <button class="modal-close" id="lm-close">✕</button>
    </div>
    <div class="modal-body">
      <form class="label-create-form" id="label-create-form">
        <input name="name" type="text" maxlength="50" placeholder="Label name…" autocomplete="off" required />
        <input name="color" type="color" value="#3b82f6" title="Pick a color" />
        <button type="submit">Create</button>
      </form>
      <div id="lm-error" class="lm-error hidden"></div>
      <ul class="label-list" id="label-list">
        ${labels.map(renderLabelRow).join('')}
      </ul>
    </div>
  `;
  document.getElementById('lm-close').addEventListener('click', closeLabelManager);
  document.getElementById('label-create-form').addEventListener('submit', handleCreateLabel);
  document.querySelectorAll('.label-edit-form').forEach(bindLabelEditForm);
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => handleDeleteLabel(btn.dataset.labelId));
  });
}

function renderLabelRow(label) {
  return `
    <li class="label-row" data-label-id="${escapeHtml(label.id)}">
      <form class="label-edit-form" data-label-id="${escapeHtml(label.id)}">
        <span class="label-color-swatch" style="background:${escapeHtml(label.color)}"></span>
        <input name="name" type="text" maxlength="50" value="${escapeHtml(label.name)}" required />
        <input name="color" type="color" value="${escapeHtml(label.color)}" title="Pick a color" />
        <button type="submit" class="btn-save">Save</button>
      </form>
      <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete label">🗑</button>
    </li>
  `;
}

function showLmError(msg) {
  const el = document.getElementById('lm-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

async function handleCreateLabel(event) {
  event.preventDefault();
  const form = event.target;
  const name = form.elements.name.value.trim();
  const color = form.elements.color.value;
  if (!name) return;
  try {
    const res = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!res.ok) {
      const data = await res.json();
      showLmError(data.error || 'Failed to create label');
      return;
    }
    form.elements.name.value = '';
    // SSE will update labels list
  } catch (err) {
    showLmError(err.message);
  }
}

function bindLabelEditForm(form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const labelId = form.dataset.labelId;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return;
    try {
      const res = await fetch(`${API_BASE}/api/labels/${labelId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color }),
      });
      if (!res.ok) {
        const data = await res.json();
        showLmError(data.error || 'Failed to update label');
      }
      // SSE will update
    } catch (err) {
      showLmError(err.message);
    }
  });
}

async function handleDeleteLabel(labelId) {
  if (!confirm('Delete this label? It will be removed from all cards.')) return;
  try {
    const res = await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      const data = await res.json().catch(() => ({}));
      showLmError(data.error || 'Failed to delete label');
    }
    // SSE will update
  } catch (err) {
    showLmError(err.message);
  }
}

// ── card label assignment panel ───────────────────────────────────────────────

let cardLabelPanelCardId = null;

function openCardLabelPanel(cardId) {
  cardLabelPanelCardId = cardId;
  const overlay = document.getElementById('card-label-overlay');
  const panel = document.getElementById('card-label-panel');
  overlay.classList.remove('hidden');
  panel.classList.remove('hidden');
  renderCardLabelPanel(cardId);
}

function closeCardLabelPanel() {
  cardLabelPanelCardId = null;
  document.getElementById('card-label-overlay').classList.add('hidden');
  document.getElementById('card-label-panel').classList.add('hidden');
}

function renderCardLabelPanel(cardId) {
  const found = findCard(cardId);
  if (!found) { closeCardLabelPanel(); return; }
  const card = found.card;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  const panel = document.getElementById('card-label-panel');
  panel.innerHTML = `
    <div class="modal-header">
      <h2>Card Labels</h2>
      <button class="modal-close" id="clp-close">✕</button>
    </div>
    <div class="modal-body">
      <p class="clp-card-text">${escapeHtml(card.text)}</p>
      ${
        labels.length === 0
          ? '<p class="clp-empty">No labels yet. Create some in the Label Manager.</p>'
          : `<ul class="clp-label-list">
          ${labels
            .map(
              (l) => `
            <li class="clp-label-row">
              <label class="clp-label-item">
                <input type="checkbox" class="clp-checkbox" data-label-id="${escapeHtml(l.id)}" ${cardLabelIds.has(l.id) ? 'checked' : ''} />
                <span class="label-chip" style="background:${escapeHtml(l.color)}">${escapeHtml(l.name)}</span>
              </label>
            </li>
          `
            )
            .join('')}
        </ul>`
      }
    </div>
  `;
  document.getElementById('clp-close').addEventListener('click', closeCardLabelPanel);
  panel.querySelectorAll('.clp-checkbox').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const labelId = cb.dataset.labelId;
      if (cb.checked) {
        await assignLabel(cardId, labelId);
      } else {
        await unassignLabel(cardId, labelId);
      }
    });
  });
}

async function assignLabel(cardId, labelId) {
  try {
    const res = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus(`Assign failed: ${data.error || 'unknown'}`, true);
    }
    // SSE will update
  } catch (err) {
    setStatus(`Assign failed: ${err.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const res = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus(`Unassign failed: ${data.error || 'unknown'}`, true);
    }
    // SSE will update
  } catch (err) {
    setStatus(`Unassign failed: ${err.message}`, true);
  }
}

// ── event binding ─────────────────────────────────────────────────────────────

function bindEvents() {
  // Label manager button
  document.getElementById('btn-manage-labels')?.addEventListener('click', openLabelManager);

  // Overlay clicks close modals
  document.getElementById('label-manager-overlay')?.addEventListener('click', closeLabelManager);
  document.getElementById('card-label-overlay')?.addEventListener('click', closeCardLabelPanel);

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.filterId;
      if (activeFilters.has(id)) {
        activeFilters.delete(id);
      } else {
        activeFilters.add(id);
      }
      render();
    });
  });
  document.getElementById('filter-clear')?.addEventListener('click', () => {
    activeFilters.clear();
    render();
  });

  // Card label buttons
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCardLabelPanel(btn.dataset.cardId);
    });
  });

  // Add card forms
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

  // Drag and drop
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
    zone.addEventListener('dragleave', (event) => {
      if (!zone.contains(event.relatedTarget)) zone.classList.remove('drop-target');
    });
    zone.addEventListener('drop', async (event) => {
      event.preventDefault();
      zone.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = zone.dataset.columnId;
      const { afterId, beforeId } = getDropNeighbors(zone, draggedCardId, event.clientY);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });
}

// ── drag helpers ──────────────────────────────────────────────────────────────

function getDropNeighbors(list, cardId, clientY) {
  const cards = [...list.querySelectorAll('.card')].filter((el) => el.dataset.cardId !== cardId);
  let afterEl = null;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (clientY > rect.top + rect.height / 2) afterEl = card;
  }
  const afterId = afterEl ? afterEl.dataset.cardId : null;
  const afterIndex = afterEl ? cards.indexOf(afterEl) : -1;
  const beforeEl = afterIndex < cards.length - 1 ? cards[afterIndex + 1] : null;
  const beforeId = beforeEl ? beforeEl.dataset.cardId : null;
  return { afterId, beforeId };
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

// ── SSE / state application ───────────────────────────────────────────────────

function applyMutation(message) {
  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    // Re-render open card label panel if it's open
    if (cardLabelPanelCardId) renderCardLabelPanel(cardLabelPanelCardId);
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
  if (cardLabelPanelCardId) renderCardLabelPanel(cardLabelPanelCardId);
  setStatus('Synced');
}

function applyLabelEvent(message) {
  const { type } = message;

  if (type === 'label-created') {
    if (!labels.find((l) => l.id === message.label.id)) {
      labels.push(message.label);
      labels.sort((a, b) => a.name.localeCompare(b.name));
    }
    render();
    if (document.getElementById('label-manager') && !document.getElementById('label-manager').classList.contains('hidden')) {
      renderLabelManager();
    }
    return;
  }

  if (type === 'label-updated') {
    const idx = labels.findIndex((l) => l.id === message.label.id);
    if (idx !== -1) labels[idx] = message.label;
    else labels.push(message.label);
    labels.sort((a, b) => a.name.localeCompare(b.name));
    // Update label data on all cards
    for (const col of board.columns) {
      for (const card of col.cards) {
        card.labels = (card.labels || []).map((l) =>
          l.id === message.label.id ? message.label : l
        );
      }
    }
    render();
    if (document.getElementById('label-manager') && !document.getElementById('label-manager').classList.contains('hidden')) {
      renderLabelManager();
    }
    if (cardLabelPanelCardId) renderCardLabelPanel(cardLabelPanelCardId);
    return;
  }

  if (type === 'label-deleted') {
    labels = labels.filter((l) => l.id !== message.labelId);
    activeFilters.delete(message.labelId);
    // Remove label from all cards
    for (const col of board.columns) {
      for (const card of col.cards) {
        card.labels = (card.labels || []).filter((l) => l.id !== message.labelId);
      }
    }
    render();
    if (document.getElementById('label-manager') && !document.getElementById('label-manager').classList.contains('hidden')) {
      renderLabelManager();
    }
    if (cardLabelPanelCardId) renderCardLabelPanel(cardLabelPanelCardId);
    return;
  }

  if (type === 'card-label-assigned' || type === 'card-label-unassigned') {
    // Update the card in our local board state
    if (message.card) {
      const card = message.card;
      for (const col of board.columns) {
        const idx = col.cards.findIndex((c) => c.id === card.id);
        if (idx !== -1) {
          col.cards[idx] = { ...col.cards[idx], labels: card.labels || [] };
        }
      }
    }
    render();
    if (cardLabelPanelCardId) renderCardLabelPanel(cardLabelPanelCardId);
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
