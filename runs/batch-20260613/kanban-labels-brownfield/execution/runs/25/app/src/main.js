import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];
let activeFilters = new Set(); // label IDs currently used to filter
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
        .map((card) => ({ ...card, labels: card.labels || [] }))
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  return { columns };
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

// ─── Filtering ───

function cardPassesFilter(card) {
  if (activeFilters.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const filterId of activeFilters) {
    if (cardLabelIds.has(filterId)) return true;
  }
  return false;
}

// ─── Contrast helper ───

function textColorForBg(hex) {
  const c = hex.replace('#', '');
  const full = c.length === 3 ? c.split('').map((ch) => ch + ch).join('') : c;
  const r = parseInt(full.substring(0, 2), 16);
  const g = parseInt(full.substring(2, 4), 16);
  const b = parseInt(full.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

// ─── Render ───

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
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
  if (allLabels.length === 0) return '';
  return `
    <div class="filter-bar">
      <span class="filter-bar-title">Filter by label:</span>
      ${allLabels.map((label) => {
        const active = activeFilters.has(label.id);
        return `<button class="filter-chip ${active ? 'active' : ''}" data-filter-label-id="${escapeHtml(label.id)}"
          style="background:${active ? escapeHtml(label.color) : '#e2e8f0'};color:${active ? textColorForBg(label.color) : '#334155'};border-color:${escapeHtml(label.color)}">
          ${escapeHtml(label.name)}
        </button>`;
      }).join('')}
      ${activeFilters.size > 0 ? '<button class="filter-clear" id="clear-filters">Clear</button>' : ''}
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
        ${column.cards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const visible = cardPassesFilter(card);
  const labelsHtml = (card.labels || []).map((label) =>
    `<span class="label-chip" style="background:${escapeHtml(label.color)};color:${textColorForBg(label.color)}">${escapeHtml(label.name)}</span>`
  ).join('');

  return `
    <article class="card ${visible ? '' : 'card-hidden'}" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml ? `<div class="card-labels">${labelsHtml}</div>` : ''}
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷️</button>
    </article>
  `;
}

function renderLabelManager() {
  return `
    <div id="label-manager" class="label-manager">
      <button id="label-manager-toggle" class="label-manager-toggle" title="Manage Labels">🏷️ Labels</button>
      <div id="label-manager-panel" class="label-manager-panel hidden">
        <h3>Manage Labels</h3>
        <form id="create-label-form" class="create-label-form">
          <input name="name" type="text" placeholder="Label name…" autocomplete="off" maxlength="50" required />
          <input name="color" type="color" value="#2563eb" title="Label color" />
          <button type="submit">Add</button>
        </form>
        <div id="label-list" class="label-list">
          ${allLabels.map((label) => `
            <div class="label-item" data-label-id="${escapeHtml(label.id)}">
              <span class="label-chip" style="background:${escapeHtml(label.color)};color:${textColorForBg(label.color)}">${escapeHtml(label.name)}</span>
              <button class="label-edit-btn" data-label-id="${escapeHtml(label.id)}" title="Edit">✏️</button>
              <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete">🗑️</button>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

// ─── Events ───

function bindEvents() {
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
  document.querySelectorAll('.card[draggable=true]').forEach((el) => {
    el.addEventListener('dragstart', (event) => {
      draggedCardId = el.dataset.cardId;
      el.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      draggedCardId = null;
      el.classList.remove('dragging');
      document.querySelectorAll('.drop-target').forEach((d) => d.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      list.classList.add('drop-target');
      positionGhost(event, list);
    });
    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) list.classList.remove('drop-target');
    });
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = list.dataset.columnId;
      const { afterId, beforeId } = resolveDropPosition(list, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      try {
        const response = await fetch(`${API_BASE}/api/cards/${draggedCardId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
        setStatus('Synced');
      } catch (error) {
        setStatus(`Move failed: ${error.message}`, true);
        board = normalizeBoard(await (await fetch(`${API_BASE}/api/board`)).json());
        render();
      }
    });
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
  const clearBtn = document.getElementById('clear-filters');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilters.clear();
      render();
    });
  }

  // Label manager toggle
  const toggleBtn = document.getElementById('label-manager-toggle');
  const panel = document.getElementById('label-manager-panel');
  if (toggleBtn && panel) {
    toggleBtn.addEventListener('click', () => {
      panel.classList.toggle('hidden');
    });
  }

  // Create label
  const createLabelForm = document.getElementById('create-label-form');
  if (createLabelForm) {
    createLabelForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = createLabelForm.elements.name.value.trim();
      const color = createLabelForm.elements.color.value;
      if (!name) return;
      try {
        const response = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!response.ok) {
          const data = await response.json();
          setStatus(`Label error: ${data.error}`, true);
          return;
        }
        createLabelForm.elements.name.value = '';
      } catch (error) {
        setStatus(`Label error: ${error.message}`, true);
      }
    });
  }

  // Edit label buttons
  document.querySelectorAll('.label-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const labelId = btn.dataset.labelId;
      const label = allLabels.find((l) => l.id === labelId);
      if (!label) return;
      openLabelEditDialog(label);
    });
  });

  // Delete label buttons
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      if (!confirm('Delete this label? It will be removed from all cards.')) return;
      try {
        const response = await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Delete failed');
      } catch (error) {
        setStatus(`Delete failed: ${error.message}`, true);
      }
    });
  });

  // Card label assignment buttons
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const cardId = btn.dataset.cardId;
      openCardLabelPopover(cardId, btn);
    });
  });
}

// ─── Label edit dialog ───

function openLabelEditDialog(label) {
  // Remove any existing dialog
  closeDialogs();
  const dialog = document.createElement('div');
  dialog.className = 'label-edit-dialog';
  dialog.innerHTML = `
    <div class="label-edit-dialog-backdrop"></div>
    <div class="label-edit-dialog-content">
      <h4>Edit Label</h4>
      <form id="edit-label-form">
        <input name="name" type="text" value="${escapeHtml(label.name)}" maxlength="50" required />
        <input name="color" type="color" value="${escapeHtml(label.color)}" />
        <div class="label-edit-actions">
          <button type="submit">Save</button>
          <button type="button" class="cancel-btn">Cancel</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(dialog);

  dialog.querySelector('.label-edit-dialog-backdrop').addEventListener('click', () => dialog.remove());
  dialog.querySelector('.cancel-btn').addEventListener('click', () => dialog.remove());
  dialog.querySelector('#edit-label-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = event.target.elements.name.value.trim();
    const color = event.target.elements.color.value;
    if (!name) return;
    try {
      const response = await fetch(`${API_BASE}/api/labels/${label.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color }),
      });
      if (!response.ok) {
        const data = await response.json();
        setStatus(`Update error: ${data.error}`, true);
        return;
      }
      dialog.remove();
    } catch (error) {
      setStatus(`Update failed: ${error.message}`, true);
    }
  });
}

// ─── Card label popover ───

function openCardLabelPopover(cardId, anchorEl) {
  closeDialogs();
  const card = findCard(cardId);
  if (!card) return;
  const assignedIds = new Set((card.card.labels || []).map((l) => l.id));

  const popover = document.createElement('div');
  popover.className = 'card-label-popover';
  popover.innerHTML = `
    <div class="card-label-popover-backdrop"></div>
    <div class="card-label-popover-content">
      <h4>Card Labels</h4>
      ${allLabels.length === 0 ? '<p class="no-labels-msg">No labels yet. Create one first.</p>' : ''}
      ${allLabels.map((label) => {
        const assigned = assignedIds.has(label.id);
        return `
          <label class="card-label-option">
            <input type="checkbox" data-label-id="${escapeHtml(label.id)}" ${assigned ? 'checked' : ''} />
            <span class="label-chip" style="background:${escapeHtml(label.color)};color:${textColorForBg(label.color)}">${escapeHtml(label.name)}</span>
          </label>
        `;
      }).join('')}
      <button class="popover-close-btn">Close</button>
    </div>
  `;
  document.body.appendChild(popover);

  popover.querySelector('.card-label-popover-backdrop').addEventListener('click', () => popover.remove());
  popover.querySelector('.popover-close-btn').addEventListener('click', () => popover.remove());

  popover.querySelectorAll('input[type=checkbox]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const labelId = checkbox.dataset.labelId;
      try {
        if (checkbox.checked) {
          const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId }),
          });
          if (!response.ok) throw new Error('Assign failed');
        } else {
          const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
            method: 'DELETE',
          });
          if (!response.ok) throw new Error('Unassign failed');
        }
      } catch (error) {
        setStatus(`Label error: ${error.message}`, true);
        checkbox.checked = !checkbox.checked; // revert
      }
    });
  });
}

function closeDialogs() {
  document.querySelectorAll('.label-edit-dialog, .card-label-popover').forEach((el) => el.remove());
}

// ─── Drag helpers ───

function positionGhost(event, list) {
  const cardEls = [...list.querySelectorAll('.card:not(.dragging)')];
  const nextCard = cardEls.find((el) => {
    const rect = el.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2;
  });
  if (nextCard) list.insertBefore(list.querySelector('.card.dragging'), nextCard);
  else if (list.querySelector('.card.dragging')) list.appendChild(list.querySelector('.card.dragging'));
}

function resolveDropPosition(list, cardId) {
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

// ─── API calls ───

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

// ─── SSE mutation handling ───

function applyMutation(message) {
  // Handle label-specific mutations
  if (message.type === 'label-created') {
    if (message.label && !allLabels.find((l) => l.id === message.label.id)) {
      allLabels.push(message.label);
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-updated') {
    const idx = allLabels.findIndex((l) => l.id === message.label.id);
    if (idx !== -1) {
      allLabels[idx] = message.label;
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-deleted') {
    allLabels = allLabels.filter((l) => l.id !== message.labelId);
    activeFilters.delete(message.labelId);
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-assigned' || message.type === 'label-unassigned') {
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }

  // Original mutation handling
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

// ─── Init ───

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
