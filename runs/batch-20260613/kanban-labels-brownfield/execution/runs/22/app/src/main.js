import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];
let selectedLabelIds = new Set(); // client-side filter state
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelManagerOpen = false;
let cardLabelMenuCardId = null; // which card's label menu is open

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

function cardMatchesFilter(card) {
  if (selectedLabelIds.size === 0) return true;
  const cardLabelIds = (card.labels || []).map((l) => l.id);
  for (const id of selectedLabelIds) {
    if (cardLabelIds.includes(id)) return true;
  }
  return false;
}

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-right">
        <button id="manage-labels-btn" class="manage-labels-btn">🏷️ Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    ${labelManagerOpen ? renderLabelManager() : ''}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderFilterBar() {
  if (allLabels.length === 0) return '';
  return `
    <div class="filter-bar">
      <span class="filter-label-text">Filter by label:</span>
      ${allLabels.map((label) => {
        const active = selectedLabelIds.has(label.id);
        return `<button class="filter-chip ${active ? 'active' : ''}" data-label-id="${escapeHtml(label.id)}" style="--chip-color: ${escapeHtml(label.color)}">
          ${escapeHtml(label.name)}
        </button>`;
      }).join('')}
      ${selectedLabelIds.size > 0 ? '<button class="filter-clear" id="clear-filter">Clear</button>' : ''}
    </div>
  `;
}

function renderLabelManager() {
  return `
    <div class="label-manager-overlay" id="label-manager-overlay">
      <div class="label-manager">
        <div class="label-manager-header">
          <h3>Manage Labels</h3>
          <button class="label-manager-close" id="label-manager-close">✕</button>
        </div>
        <form class="label-create-form" id="label-create-form">
          <input type="text" name="name" placeholder="Label name…" maxlength="50" autocomplete="off" required />
          <input type="color" name="color" value="#3b82f6" />
          <button type="submit">Create</button>
        </form>
        <div class="label-list">
          ${allLabels.map((label) => `
            <div class="label-item" data-label-id="${escapeHtml(label.id)}">
              <span class="label-chip-preview" style="background: ${escapeHtml(label.color)}"></span>
              <input type="text" class="label-name-input" value="${escapeHtml(label.name)}" data-label-id="${escapeHtml(label.id)}" data-original="${escapeHtml(label.name)}" />
              <input type="color" class="label-color-input" value="${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}" data-original="${escapeHtml(label.color)}" />
              <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete label">🗑️</button>
            </div>
          `).join('')}
          ${allLabels.length === 0 ? '<p class="no-labels">No labels yet. Create one above.</p>' : ''}
        </div>
      </div>
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
        ${column.cards.map((card) => renderCard(card, column.id)).join('')}
      </div>
    </section>
  `;
}

function renderCard(card, _columnId) {
  const visible = cardMatchesFilter(card);
  const labelsHtml = (card.labels || []).map((label) =>
    `<span class="card-label-chip" style="background: ${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`
  ).join('');
  const isMenuOpen = cardLabelMenuCardId === card.id;
  return `
    <article class="card ${!visible ? 'card-hidden' : ''}" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml ? `<div class="card-labels">${labelsHtml}</div>` : ''}
      <button class="card-label-toggle" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷️</button>
      ${isMenuOpen ? renderCardLabelMenu(card) : ''}
    </article>
  `;
}

function renderCardLabelMenu(card) {
  const assignedIds = new Set((card.labels || []).map((l) => l.id));
  if (allLabels.length === 0) {
    return `<div class="card-label-menu">
      <p class="no-labels">No labels available.</p>
    </div>`;
  }
  return `
    <div class="card-label-menu">
      ${allLabels.map((label) => {
        const assigned = assignedIds.has(label.id);
        return `<div class="card-label-menu-item ${assigned ? 'assigned' : ''}" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}" data-assigned="${assigned}">
          <span class="card-label-chip-small" style="background: ${escapeHtml(label.color)}"></span>
          <span>${escapeHtml(label.name)}</span>
          <span class="checkmark">${assigned ? '✓' : ''}</span>
        </div>`;
      }).join('')}
    </div>
  `;
}

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

  // Drag and drop on cards
  document.querySelectorAll('.card').forEach((el) => {
    el.addEventListener('dragstart', (event) => {
      draggedCardId = el.dataset.cardId;
      el.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      draggedCardId = null;
      el.classList.remove('dragging');
      document.querySelectorAll('.drop-target').forEach((zone) => zone.classList.remove('drop-target'));
    });
  });

  // Drop zones
  document.querySelectorAll('.cards').forEach((zone) => {
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      zone.classList.add('drop-target');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drop-target'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = zone.dataset.columnId;
      const cardId = draggedCardId;
      draggedCardId = null;

      const target = getDropTarget(event, zone);
      const { afterId, beforeId } = resolveNeighbours(zone, cardId);
      const finalAfterId = target?.afterId ?? afterId;
      const finalBeforeId = target?.beforeId ?? beforeId;

      optimisticMove(cardId, columnId, finalBeforeId, finalAfterId);
      render();
      moveCard(cardId, columnId, finalBeforeId, finalAfterId);
    });
  });

  // Label manager toggle
  const manageBtn = document.getElementById('manage-labels-btn');
  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      labelManagerOpen = !labelManagerOpen;
      cardLabelMenuCardId = null;
      render();
    });
  }

  // Label manager close
  const closeBtn = document.getElementById('label-manager-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      labelManagerOpen = false;
      render();
    });
  }

  // Label manager overlay click to close
  const overlay = document.getElementById('label-manager-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        labelManagerOpen = false;
        render();
      }
    });
  }

  // Label create form
  const createForm = document.getElementById('label-create-form');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
      if (!name) return;
      await apiCreateLabel(name, color);
      createForm.elements.name.value = '';
    });
  }

  // Label rename (on blur)
  document.querySelectorAll('.label-name-input').forEach((input) => {
    input.addEventListener('change', async () => {
      const labelId = input.dataset.labelId;
      const newName = input.value.trim();
      const origName = input.dataset.original;
      if (!newName || newName === origName) {
        input.value = origName;
        return;
      }
      await apiUpdateLabel(labelId, { name: newName });
    });
  });

  // Label recolor
  document.querySelectorAll('.label-color-input').forEach((input) => {
    input.addEventListener('change', async () => {
      const labelId = input.dataset.labelId;
      const newColor = input.value;
      const origColor = input.dataset.original;
      if (newColor === origColor) return;
      await apiUpdateLabel(labelId, { color: newColor });
    });
  });

  // Label delete
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      await apiDeleteLabel(labelId);
    });
  });

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const labelId = chip.dataset.labelId;
      if (selectedLabelIds.has(labelId)) {
        selectedLabelIds.delete(labelId);
      } else {
        selectedLabelIds.add(labelId);
      }
      render();
    });
  });

  // Clear filter
  const clearBtn = document.getElementById('clear-filter');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      selectedLabelIds.clear();
      render();
    });
  }

  // Card label toggle buttons
  document.querySelectorAll('.card-label-toggle').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      if (cardLabelMenuCardId === cardId) {
        cardLabelMenuCardId = null;
      } else {
        cardLabelMenuCardId = cardId;
      }
      render();
    });
  });

  // Card label menu items (assign/unassign)
  document.querySelectorAll('.card-label-menu-item').forEach((item) => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardId = item.dataset.cardId;
      const labelId = item.dataset.labelId;
      const assigned = item.dataset.assigned === 'true';
      if (assigned) {
        await apiUnassignLabel(cardId, labelId);
      } else {
        await apiAssignLabel(cardId, labelId);
      }
    });
  });

  // Close card label menu when clicking outside
  document.addEventListener('click', (e) => {
    if (cardLabelMenuCardId && !e.target.closest('.card-label-menu') && !e.target.closest('.card-label-toggle')) {
      cardLabelMenuCardId = null;
      render();
    }
  });
}

function getDropTarget(event, zone) {
  const cards = [...zone.querySelectorAll('.card:not(.dragging)')];
  if (cards.length === 0) return { afterId: null, beforeId: null };

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (event.clientY < midY) {
      const beforeId = card.dataset.cardId;
      const index = cards.indexOf(card);
      const afterId = index > 0 ? cards[index - 1].dataset.cardId : null;
      return { afterId, beforeId };
    }
  }
  const lastCard = cards[cards.length - 1];
  return { afterId: lastCard.dataset.cardId, beforeId: null };
}

function resolveNeighbours(list, cardId) {
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
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
  } catch (error) {
    setStatus(`Move failed: ${error.message}`, true);
    await loadBoard();
  }
}

// ── Label API calls ──

async function apiCreateLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) {
      const data = await response.json();
      setStatus(`Label error: ${data.error}`, true);
    }
  } catch (error) {
    setStatus(`Label create failed: ${error.message}`, true);
  }
}

async function apiUpdateLabel(id, fields) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    if (!response.ok) {
      const data = await response.json();
      setStatus(`Label error: ${data.error}`, true);
    }
  } catch (error) {
    setStatus(`Label update failed: ${error.message}`, true);
  }
}

async function apiDeleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok) {
      const data = await response.json();
      setStatus(`Label error: ${data.error}`, true);
    }
  } catch (error) {
    setStatus(`Label delete failed: ${error.message}`, true);
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
      const data = await response.json();
      setStatus(`Assign failed: ${data.error}`, true);
    }
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
  }
}

async function apiUnassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
    if (!response.ok) {
      const data = await response.json();
      setStatus(`Unassign failed: ${data.error}`, true);
    }
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
  }
}

// ── Label mutation helpers ──

function updateCardInBoard(updatedCard) {
  for (const column of board.columns) {
    const idx = column.cards.findIndex((c) => c.id === updatedCard.id);
    if (idx !== -1) {
      // Preserve position and column_id from existing card, update labels
      column.cards[idx] = { ...column.cards[idx], labels: updatedCard.labels || [] };
      return;
    }
  }
}

function removeLabelFromAllCards(labelId) {
  for (const column of board.columns) {
    for (const card of column.cards) {
      if (card.labels) {
        card.labels = card.labels.filter((l) => l.id !== labelId);
      }
    }
  }
}

function updateLabelInAllCards(updatedLabel) {
  for (const column of board.columns) {
    for (const card of column.cards) {
      if (card.labels) {
        card.labels = card.labels.map((l) => l.id === updatedLabel.id ? { ...l, ...updatedLabel } : l);
      }
    }
  }
}

function applyMutation(message) {
  // Handle label-specific mutations
  if (message.type === 'label-created') {
    if (!allLabels.find((l) => l.id === message.label.id)) {
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
    // Also update labels on cards in the board
    updateLabelInAllCards(message.label);
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-deleted') {
    allLabels = allLabels.filter((l) => l.id !== message.labelId);
    selectedLabelIds.delete(message.labelId);
    removeLabelFromAllCards(message.labelId);
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'card-label-assigned' || message.type === 'card-label-unassigned') {
    if (message.card) {
      updateCardInBoard(message.card);
    }
    render();
    setStatus('Synced');
    return;
  }

  // Existing board/card mutations
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

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
  render();
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
    await loadLabels();
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
