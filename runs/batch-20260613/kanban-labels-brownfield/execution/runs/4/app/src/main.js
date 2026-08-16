import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = []; // all known labels
let activeFilters = new Set(); // label ids currently selected for filtering
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
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

// Determine whether a card passes the current label filter
function cardMatchesFilter(card) {
  if (activeFilters.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const filterId of activeFilters) {
    if (cardLabelIds.has(filterId)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-right">
        <button class="btn-manage-labels" id="btn-manage-labels">🏷 Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    <div id="label-manager-overlay" class="overlay hidden"></div>
    <dialog id="label-manager" class="label-manager hidden">
      ${renderLabelManager()}
    </dialog>
    <dialog id="card-label-dialog" class="card-label-dialog hidden"></dialog>
  `;
  bindEvents();
}

function renderFilterBar() {
  if (labels.length === 0) return '<div class="filter-bar filter-bar--empty"></div>';
  return `
    <div class="filter-bar">
      <span class="filter-bar__label">Filter:</span>
      <div class="filter-bar__chips">
        ${labels
          .map(
            (l) => `
          <button
            class="filter-chip${activeFilters.has(l.id) ? ' filter-chip--active' : ''}"
            data-filter-label-id="${escapeHtml(l.id)}"
            style="--chip-color: ${escapeHtml(l.color)}"
          >${escapeHtml(l.name)}</button>
        `
          )
          .join('')}
      </div>
      ${
        activeFilters.size > 0
          ? '<button class="filter-clear" id="filter-clear">✕ Clear filter</button>'
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
          ? `<div class="card-labels">${cardLabels
              .map(
                (l) =>
                  `<span class="label-chip" style="background:${escapeHtml(l.color)};color:${chipTextColor(l.color)}">${escapeHtml(l.name)}</span>`
              )
              .join('')}</div>`
          : ''
      }
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷</button>
    </article>
  `;
}

// Pick black or white text based on background luminance
function chipTextColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? '#000000' : '#ffffff';
}

function renderLabelManager() {
  return `
    <div class="label-manager__header">
      <h2>Label Manager</h2>
      <button class="label-manager__close" id="label-manager-close">✕</button>
    </div>
    <form class="label-create-form" id="label-create-form">
      <input
        type="text"
        name="name"
        placeholder="Label name…"
        maxlength="100"
        autocomplete="off"
        required
      />
      <input type="color" name="color" value="#2563eb" title="Pick a color" />
      <button type="submit">Create</button>
    </form>
    <ul class="label-list" id="label-list">
      ${labels.map(renderLabelRow).join('')}
    </ul>
  `;
}

function renderLabelRow(label) {
  return `
    <li class="label-row" data-label-id="${escapeHtml(label.id)}">
      <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
      <span class="label-row__name">${escapeHtml(label.name)}</span>
      <button class="label-row__edit" data-label-id="${escapeHtml(label.id)}" title="Edit">✏️</button>
      <button class="label-row__delete" data-label-id="${escapeHtml(label.id)}" title="Delete">🗑</button>
    </li>
  `;
}

function renderCardLabelDialog(card) {
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  return `
    <div class="label-manager__header">
      <h2>Labels for card</h2>
      <button class="label-manager__close" id="card-label-dialog-close">✕</button>
    </div>
    <p class="card-label-dialog__card-text">${escapeHtml(card.text)}</p>
    <ul class="label-list">
      ${
        labels.length === 0
          ? '<li class="label-list__empty">No labels yet. Create some in the Label Manager.</li>'
          : labels
              .map(
                (l) => `
          <li class="label-row label-row--toggle" data-label-id="${escapeHtml(l.id)}" data-card-id="${escapeHtml(card.id)}">
            <span class="label-swatch" style="background:${escapeHtml(l.color)}"></span>
            <span class="label-row__name">${escapeHtml(l.name)}</span>
            <input
              type="checkbox"
              class="label-assign-checkbox"
              data-card-id="${escapeHtml(card.id)}"
              data-label-id="${escapeHtml(l.id)}"
              ${cardLabelIds.has(l.id) ? 'checked' : ''}
            />
          </li>
        `
              )
              .join('')
      }
    </ul>
  `;
}

// ---------------------------------------------------------------------------
// Label manager dialog
// ---------------------------------------------------------------------------
function openLabelManager() {
  const dialog = document.getElementById('label-manager');
  const overlay = document.getElementById('label-manager-overlay');
  dialog.innerHTML = renderLabelManager();
  dialog.classList.remove('hidden');
  overlay.classList.remove('hidden');
  bindLabelManagerEvents(dialog);
}

function closeLabelManager() {
  const dialog = document.getElementById('label-manager');
  const overlay = document.getElementById('label-manager-overlay');
  dialog.classList.add('hidden');
  overlay.classList.add('hidden');
}

function bindLabelManagerEvents(dialog) {
  dialog.querySelector('#label-manager-close').addEventListener('click', closeLabelManager);

  dialog.querySelector('#label-create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
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
        setStatus(`Create label failed: ${data.error}`, true);
        return;
      }
      form.elements.name.value = '';
    } catch (err) {
      setStatus(`Create label failed: ${err.message}`, true);
    }
  });

  dialog.querySelectorAll('.label-row__delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      if (!confirm('Delete this label? It will be removed from all cards.')) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 204) {
          const data = await res.json();
          setStatus(`Delete label failed: ${data.error}`, true);
        }
      } catch (err) {
        setStatus(`Delete label failed: ${err.message}`, true);
      }
    });
  });

  dialog.querySelectorAll('.label-row__edit').forEach((btn) => {
    btn.addEventListener('click', () => {
      const labelId = btn.dataset.labelId;
      const label = labels.find((l) => l.id === labelId);
      if (!label) return;
      openEditLabelInline(dialog, labelId, label);
    });
  });
}

function openEditLabelInline(dialog, labelId, label) {
  const row = dialog.querySelector(`.label-row[data-label-id="${labelId}"]`);
  if (!row) return;
  row.innerHTML = `
    <input type="text" class="label-edit-name" value="${escapeHtml(label.name)}" maxlength="100" />
    <input type="color" class="label-edit-color" value="${escapeHtml(label.color)}" />
    <button class="label-edit-save" data-label-id="${escapeHtml(labelId)}">Save</button>
    <button class="label-edit-cancel">Cancel</button>
  `;
  row.querySelector('.label-edit-cancel').addEventListener('click', () => {
    row.outerHTML = renderLabelRow(label);
    bindLabelManagerEvents(dialog);
  });
  row.querySelector('.label-edit-save').addEventListener('click', async () => {
    const name = row.querySelector('.label-edit-name').value.trim();
    const color = row.querySelector('.label-edit-color').value;
    if (!name) {
      setStatus('Label name cannot be empty', true);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/labels/${labelId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color }),
      });
      if (!res.ok) {
        const data = await res.json();
        setStatus(`Update label failed: ${data.error}`, true);
        return;
      }
    } catch (err) {
      setStatus(`Update label failed: ${err.message}`, true);
    }
  });
}

// ---------------------------------------------------------------------------
// Card label dialog
// ---------------------------------------------------------------------------
function openCardLabelDialog(cardId) {
  const found = findCard(cardId);
  if (!found) return;
  const dialog = document.getElementById('card-label-dialog');
  const overlay = document.getElementById('label-manager-overlay');
  dialog.innerHTML = renderCardLabelDialog(found.card);
  dialog.classList.remove('hidden');
  overlay.classList.remove('hidden');
  bindCardLabelDialogEvents(dialog, cardId);
}

function closeCardLabelDialog() {
  const dialog = document.getElementById('card-label-dialog');
  const overlay = document.getElementById('label-manager-overlay');
  dialog.classList.add('hidden');
  overlay.classList.add('hidden');
}

function bindCardLabelDialogEvents(dialog, cardId) {
  dialog.querySelector('#card-label-dialog-close').addEventListener('click', closeCardLabelDialog);

  dialog.querySelectorAll('.label-assign-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const { cardId: cid, labelId } = checkbox.dataset;
      const assign = checkbox.checked;
      try {
        if (assign) {
          const res = await fetch(`${API_BASE}/api/cards/${cid}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId }),
          });
          if (!res.ok) {
            const data = await res.json();
            setStatus(`Assign label failed: ${data.error}`, true);
            checkbox.checked = !assign;
          }
        } else {
          const res = await fetch(`${API_BASE}/api/cards/${cid}/labels/${labelId}`, { method: 'DELETE' });
          if (!res.ok) {
            const data = await res.json();
            setStatus(`Unassign label failed: ${data.error}`, true);
            checkbox.checked = !assign;
          }
        }
      } catch (err) {
        setStatus(`Label assignment failed: ${err.message}`, true);
        checkbox.checked = !assign;
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Event binding
// ---------------------------------------------------------------------------
function bindEvents() {
  // Manage labels button
  document.getElementById('btn-manage-labels')?.addEventListener('click', openLabelManager);

  // Overlay click closes any open dialog
  document.getElementById('label-manager-overlay')?.addEventListener('click', () => {
    closeLabelManager();
    closeCardLabelDialog();
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
  document.getElementById('filter-clear')?.addEventListener('click', () => {
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
      await createCard(form.dataset.columnId, text);
    });
  });

  // Card label buttons
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCardLabelDialog(btn.dataset.cardId);
    });
  });

  // Drag and drop
  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    cardEl.addEventListener('dragend', () => {
      draggedCardId = null;
      cardEl.classList.remove('dragging');
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
      const { afterId, beforeId } = getDropPosition(list, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });
}

// ---------------------------------------------------------------------------
// Drag helpers
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// SSE / mutation application
// ---------------------------------------------------------------------------
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

function applyLabelEvent(message) {
  switch (message.type) {
    case 'label-created': {
      if (!labels.find((l) => l.id === message.label.id)) {
        labels.push(message.label);
        labels.sort((a, b) => a.name.localeCompare(b.name));
      }
      // Refresh label manager if open
      refreshLabelManagerIfOpen();
      render();
      break;
    }
    case 'label-updated': {
      const idx = labels.findIndex((l) => l.id === message.label.id);
      if (idx !== -1) labels[idx] = message.label;
      else labels.push(message.label);
      labels.sort((a, b) => a.name.localeCompare(b.name));
      // Update label data on cards in board
      for (const col of board.columns) {
        for (const card of col.cards) {
          card.labels = (card.labels || []).map((l) =>
            l.id === message.label.id ? message.label : l
          );
        }
      }
      refreshLabelManagerIfOpen();
      render();
      break;
    }
    case 'label-deleted': {
      labels = labels.filter((l) => l.id !== message.labelId);
      activeFilters.delete(message.labelId);
      // Remove from all cards
      for (const col of board.columns) {
        for (const card of col.cards) {
          card.labels = (card.labels || []).filter((l) => l.id !== message.labelId);
        }
      }
      refreshLabelManagerIfOpen();
      render();
      break;
    }
    case 'card-label-assigned':
    case 'card-label-unassigned': {
      if (message.board) {
        board = normalizeBoard(message.board);
      } else if (message.card) {
        // Update just the card
        for (const col of board.columns) {
          const idx = col.cards.findIndex((c) => c.id === message.cardId);
          if (idx !== -1) {
            col.cards[idx] = { ...message.card, labels: message.card.labels || [] };
          }
        }
      }
      // Refresh card label dialog if open for this card
      refreshCardLabelDialogIfOpen(message.cardId);
      render();
      setStatus('Synced');
      break;
    }
  }
}

function refreshLabelManagerIfOpen() {
  const dialog = document.getElementById('label-manager');
  if (!dialog || dialog.classList.contains('hidden')) return;
  dialog.innerHTML = renderLabelManager();
  bindLabelManagerEvents(dialog);
}

function refreshCardLabelDialogIfOpen(cardId) {
  const dialog = document.getElementById('card-label-dialog');
  if (!dialog || dialog.classList.contains('hidden')) return;
  // Check if this dialog is for the affected card
  const closeBtn = dialog.querySelector('#card-label-dialog-close');
  if (!closeBtn) return;
  // Re-render with updated card data
  const found = findCard(cardId);
  if (!found) return;
  dialog.innerHTML = renderCardLabelDialog(found.card);
  bindCardLabelDialogEvents(dialog, cardId);
}

// ---------------------------------------------------------------------------
// Board loading & SSE connection
// ---------------------------------------------------------------------------
async function loadBoard() {
  const [boardRes, labelsRes] = await Promise.all([
    fetch(`${API_BASE}/api/board`),
    fetch(`${API_BASE}/api/labels`),
  ]);
  if (!boardRes.ok) throw new Error('Could not load board');
  if (!labelsRes.ok) throw new Error('Could not load labels');
  board = normalizeBoard(await boardRes.json());
  labels = await labelsRes.json();
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
    await loadBoard();
    render();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
