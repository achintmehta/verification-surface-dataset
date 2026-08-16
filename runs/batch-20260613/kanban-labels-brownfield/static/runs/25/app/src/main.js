import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = []; // All labels from backend
let activeFilters = new Set(); // Label IDs currently filtered
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

// ===================== Utilities =====================

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
        .map((card) => ({
          ...card,
          labels: card.labels || [],
        }))
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  return { columns };
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

/** Returns contrast color (black or white) for a hex background */
function contrastColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

/** Should a card be visible given the current filter? */
function cardPassesFilter(card) {
  if (activeFilters.size === 0) return true;
  const cardLabelIds = (card.labels || []).map((l) => l.id);
  for (const filterId of activeFilters) {
    if (cardLabelIds.includes(filterId)) return true;
  }
  return false;
}

// ===================== Rendering =====================

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <button id="manage-labels-btn" class="manage-labels-btn" title="Manage labels">🏷️ Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    <div id="label-modal-overlay" class="modal-overlay hidden"></div>
    <div id="card-label-modal-overlay" class="modal-overlay hidden"></div>
  `;
  bindEvents();
}

function renderFilterBar() {
  if (allLabels.length === 0) return '';
  return `
    <div class="filter-bar">
      <span class="filter-label-text">Filter by label:</span>
      <div class="filter-chips">
        ${allLabels.map((label) => {
          const active = activeFilters.has(label.id);
          return `<button class="filter-chip ${active ? 'active' : ''}" data-label-id="${escapeHtml(label.id)}"
            style="background:${active ? escapeHtml(label.color) : 'transparent'};color:${active ? contrastColor(label.color) : escapeHtml(label.color)};border-color:${escapeHtml(label.color)}">
            ${escapeHtml(label.name)}
          </button>`;
        }).join('')}
        ${activeFilters.size > 0 ? '<button class="filter-clear-btn">Clear</button>' : ''}
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
        ${column.cards.map((card) => renderCard(card)).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const visible = cardPassesFilter(card);
  const labelsHtml = (card.labels || []).map((label) =>
    `<span class="label-chip" style="background:${escapeHtml(label.color)};color:${contrastColor(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`
  ).join('');
  return `
    <article class="card ${visible ? '' : 'card-hidden'}" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml ? `<div class="card-labels">${labelsHtml}</div>` : ''}
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels on this card">🏷️</button>
    </article>
  `;
}

// ===================== Label Manager Modal =====================

function showLabelManager() {
  const overlay = document.getElementById('label-modal-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="modal label-manager-modal">
      <div class="modal-header">
        <h3>Manage Labels</h3>
        <button class="modal-close" id="label-modal-close">&times;</button>
      </div>
      <div class="label-create-form">
        <input type="text" id="new-label-name" placeholder="Label name" maxlength="50" />
        <input type="color" id="new-label-color" value="#2563eb" />
        <button id="create-label-btn">Create</button>
      </div>
      <div class="label-list" id="label-list">
        ${allLabels.map((label) => `
          <div class="label-list-item" data-label-id="${escapeHtml(label.id)}">
            <span class="label-chip" style="background:${escapeHtml(label.color)};color:${contrastColor(label.color)}">${escapeHtml(label.name)}</span>
            <div class="label-list-actions">
              <input type="text" class="label-edit-name" value="${escapeHtml(label.name)}" maxlength="50" data-label-id="${escapeHtml(label.id)}" />
              <input type="color" class="label-edit-color" value="${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}" />
              <button class="label-save-btn" data-label-id="${escapeHtml(label.id)}">Save</button>
              <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}">🗑</button>
            </div>
          </div>
        `).join('')}
        ${allLabels.length === 0 ? '<p class="empty-msg">No labels yet.</p>' : ''}
      </div>
    </div>
  `;
  bindLabelManagerEvents();
}

function bindLabelManagerEvents() {
  const overlay = document.getElementById('label-modal-overlay');
  document.getElementById('label-modal-close')?.addEventListener('click', () => overlay.classList.add('hidden'));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });

  document.getElementById('create-label-btn')?.addEventListener('click', async () => {
    const nameInput = document.getElementById('new-label-name');
    const colorInput = document.getElementById('new-label-color');
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
        const data = await resp.json();
        alert(data.error || 'Failed to create label');
        return;
      }
      nameInput.value = '';
    } catch (error) {
      alert('Failed to create label: ' + error.message);
    }
  });

  document.querySelectorAll('.label-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.labelId;
      const nameInput = document.querySelector(`.label-edit-name[data-label-id="${id}"]`);
      const colorInput = document.querySelector(`.label-edit-color[data-label-id="${id}"]`);
      const name = nameInput.value.trim();
      const color = colorInput.value;
      if (!name) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!resp.ok) {
          const data = await resp.json();
          alert(data.error || 'Failed to update label');
          return;
        }
      } catch (error) {
        alert('Failed to update label: ' + error.message);
      }
    });
  });

  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.labelId;
      if (!confirm('Delete this label? It will be removed from all cards.')) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
        if (!resp.ok) {
          const data = await resp.json();
          alert(data.error || 'Failed to delete label');
        }
      } catch (error) {
        alert('Failed to delete label: ' + error.message);
      }
    });
  });
}

// ===================== Card Label Assignment Modal =====================

function showCardLabelModal(cardId) {
  const found = findCard(cardId);
  if (!found) return;
  const card = found.card;
  const cardLabelIds = (card.labels || []).map((l) => l.id);
  const overlay = document.getElementById('card-label-modal-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="modal card-label-modal">
      <div class="modal-header">
        <h3>Labels for: ${escapeHtml(card.text.length > 40 ? card.text.slice(0, 40) + '…' : card.text)}</h3>
        <button class="modal-close" id="card-label-modal-close">&times;</button>
      </div>
      <div class="card-label-list">
        ${allLabels.map((label) => {
          const assigned = cardLabelIds.includes(label.id);
          return `
            <div class="card-label-row">
              <label class="card-label-toggle">
                <input type="checkbox" ${assigned ? 'checked' : ''} data-card-id="${escapeHtml(cardId)}" data-label-id="${escapeHtml(label.id)}" class="card-label-checkbox" />
                <span class="label-chip" style="background:${escapeHtml(label.color)};color:${contrastColor(label.color)}">${escapeHtml(label.name)}</span>
              </label>
            </div>
          `;
        }).join('')}
        ${allLabels.length === 0 ? '<p class="empty-msg">No labels available. Create some first!</p>' : ''}
      </div>
    </div>
  `;
  bindCardLabelModalEvents(cardId);
}

function bindCardLabelModalEvents(cardId) {
  const overlay = document.getElementById('card-label-modal-overlay');
  document.getElementById('card-label-modal-close')?.addEventListener('click', () => overlay.classList.add('hidden'));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });

  document.querySelectorAll('.card-label-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const labelId = checkbox.dataset.labelId;
      const cid = checkbox.dataset.cardId;
      try {
        if (checkbox.checked) {
          const resp = await fetch(`${API_BASE}/api/cards/${cid}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId }),
          });
          if (!resp.ok) throw new Error((await resp.json()).error);
        } else {
          const resp = await fetch(`${API_BASE}/api/cards/${cid}/labels/${labelId}`, { method: 'DELETE' });
          if (!resp.ok) throw new Error((await resp.json()).error);
        }
      } catch (error) {
        alert('Error: ' + error.message);
        checkbox.checked = !checkbox.checked;
      }
    });
  });
}

// ===================== Event Binding =====================

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
  document.querySelectorAll('.card').forEach((el) => {
    el.addEventListener('dragstart', (event) => {
      draggedCardId = el.dataset.cardId;
      el.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      draggedCardId = null;
      document.querySelectorAll('.drop-target').forEach((zone) => zone.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((zone) => {
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      zone.classList.add('drop-target');

      const draggingEl = document.querySelector('.card.dragging');
      if (!draggingEl) return;
      const afterElement = getDragAfterElement(zone, event.clientY);
      if (afterElement) {
        zone.insertBefore(draggingEl, afterElement);
      } else {
        zone.appendChild(draggingEl);
      }
    });
    zone.addEventListener('dragleave', (event) => {
      if (!zone.contains(event.relatedTarget)) zone.classList.remove('drop-target');
    });
    zone.addEventListener('drop', async (event) => {
      event.preventDefault();
      zone.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = zone.dataset.columnId;
      const { afterId, beforeId } = getNeighborIds(zone, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });

  // Label manager button
  document.getElementById('manage-labels-btn')?.addEventListener('click', showLabelManager);

  // Card label buttons
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showCardLabelModal(btn.dataset.cardId);
    });
  });

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const labelId = chip.dataset.labelId;
      if (activeFilters.has(labelId)) {
        activeFilters.delete(labelId);
      } else {
        activeFilters.add(labelId);
      }
      render();
    });
  });

  // Clear filter
  document.querySelector('.filter-clear-btn')?.addEventListener('click', () => {
    activeFilters.clear();
    render();
  });
}

// ===================== Drag helpers =====================

function getDragAfterElement(zone, y) {
  const els = [...zone.querySelectorAll('.card:not(.dragging)')];
  let closest = null;
  let closestOffset = Number.NEGATIVE_INFINITY;
  for (const el of els) {
    const box = el.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = el;
    }
  }
  return closest;
}

function getNeighborIds(list, cardId) {
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

// ===================== API calls =====================

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

// ===================== SSE Mutations =====================

function applyMutation(message) {
  // --- Label mutations ---
  if (message.type === 'label-created') {
    const label = message.label;
    if (!allLabels.find((l) => l.id === label.id)) {
      allLabels.push(label);
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
    }
    render();
    // Re-open label manager if it was open
    if (!document.getElementById('label-modal-overlay')?.classList.contains('hidden')) {
      showLabelManager();
    }
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-updated') {
    const label = message.label;
    const idx = allLabels.findIndex((l) => l.id === label.id);
    if (idx !== -1) {
      allLabels[idx] = label;
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
    }
    // Update labels on cards
    for (const col of board.columns) {
      for (const card of col.cards) {
        const li = (card.labels || []).findIndex((l) => l.id === label.id);
        if (li !== -1) {
          card.labels[li] = { ...label };
        }
      }
    }
    render();
    if (!document.getElementById('label-modal-overlay')?.classList.contains('hidden')) {
      showLabelManager();
    }
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-deleted') {
    const labelId = message.labelId;
    allLabels = allLabels.filter((l) => l.id !== labelId);
    activeFilters.delete(labelId);
    // Remove from all cards
    for (const col of board.columns) {
      for (const card of col.cards) {
        card.labels = (card.labels || []).filter((l) => l.id !== labelId);
      }
    }
    render();
    if (!document.getElementById('label-modal-overlay')?.classList.contains('hidden')) {
      showLabelManager();
    }
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-assigned') {
    const { cardId, label } = message;
    const found = findCard(cardId);
    if (found) {
      if (!found.card.labels) found.card.labels = [];
      if (!found.card.labels.find((l) => l.id === label.id)) {
        found.card.labels.push(label);
        found.card.labels.sort((a, b) => a.name.localeCompare(b.name));
      }
    }
    render();
    // Re-open card label modal if it was open for this card
    if (!document.getElementById('card-label-modal-overlay')?.classList.contains('hidden')) {
      showCardLabelModal(cardId);
    }
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-unassigned') {
    const { cardId, labelId } = message;
    const found = findCard(cardId);
    if (found) {
      found.card.labels = (found.card.labels || []).filter((l) => l.id !== labelId);
    }
    render();
    if (!document.getElementById('card-label-modal-overlay')?.classList.contains('hidden')) {
      showCardLabelModal(cardId);
    }
    setStatus('Synced');
    return;
  }

  // --- Board/card mutations (original) ---
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

// ===================== Load & Connect =====================

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
}

async function loadLabels() {
  const response = await fetch(`${API_BASE}/api/labels`);
  if (!response.ok) throw new Error('Could not load labels');
  allLabels = await response.json();
  allLabels.sort((a, b) => a.name.localeCompare(b.name));
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
