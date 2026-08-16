import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];
let activeFilters = new Set(); // label IDs currently filtering
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let openLabelCardId = null; // card ID whose label popup is open

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
  if (activeFilters.size === 0) return true;
  const cardLabelIds = (card.labels || []).map((l) => l.id);
  for (const filterId of activeFilters) {
    if (cardLabelIds.includes(filterId)) return true;
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
      <div class="topbar-actions">
        <button id="manage-labels-btn" class="manage-labels-btn">🏷️ Manage Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    <div id="label-manager-overlay" class="overlay hidden">
      <div class="label-manager">
        <div class="label-manager-header">
          <h2>Manage Labels</h2>
          <button class="close-btn" id="close-label-manager">✕</button>
        </div>
        <form id="create-label-form" class="create-label-form">
          <input name="name" type="text" placeholder="Label name…" autocomplete="off" maxlength="50" />
          <input name="color" type="color" value="#2563eb" />
          <button type="submit">Create</button>
        </form>
        <div id="labels-list" class="labels-list">
          ${allLabels.map(renderLabelRow).join('')}
        </div>
      </div>
    </div>
  `;
  bindEvents();
}

function renderFilterBar() {
  if (allLabels.length === 0) return '';
  return `
    <div class="filter-bar">
      <span class="filter-label">Filter by label:</span>
      ${allLabels.map((label) => {
        const active = activeFilters.has(label.id);
        return `<button class="filter-chip ${active ? 'active' : ''}" data-label-id="${escapeHtml(label.id)}" style="--chip-color: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</button>`;
      }).join('')}
      ${activeFilters.size > 0 ? '<button class="filter-clear" id="clear-filters">Clear</button>' : ''}
    </div>
  `;
}

function renderLabelRow(label) {
  return `
    <div class="label-row" data-label-id="${escapeHtml(label.id)}">
      <span class="label-chip" style="background: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
      <div class="label-row-actions">
        <button class="label-edit-btn" data-label-id="${escapeHtml(label.id)}">Edit</button>
        <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}">Delete</button>
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
        ${column.cards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const visible = cardMatchesFilter(card);
  const labelsHtml = (card.labels || []).map((label) =>
    `<span class="card-label-chip" style="background: ${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`
  ).join('');

  const isPopupOpen = openLabelCardId === card.id;

  return `
    <article class="card ${!visible ? 'card-hidden' : ''}" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml ? `<div class="card-labels">${labelsHtml}</div>` : ''}
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Assign labels">🏷️</button>
      ${isPopupOpen ? renderLabelPopup(card) : ''}
    </article>
  `;
}

function renderLabelPopup(card) {
  const cardLabelIds = (card.labels || []).map((l) => l.id);
  if (allLabels.length === 0) {
    return `
      <div class="label-popup">
        <div class="label-popup-header">
          <span>Labels</span>
          <button class="close-popup-btn" data-card-id="${escapeHtml(card.id)}">✕</button>
        </div>
        <p class="label-popup-empty">No labels yet. Create one in Manage Labels.</p>
      </div>
    `;
  }
  return `
    <div class="label-popup">
      <div class="label-popup-header">
        <span>Labels</span>
        <button class="close-popup-btn" data-card-id="${escapeHtml(card.id)}">✕</button>
      </div>
      ${allLabels.map((label) => {
        const assigned = cardLabelIds.includes(label.id);
        return `
          <label class="label-popup-item">
            <input type="checkbox" ${assigned ? 'checked' : ''} data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}" class="label-assign-checkbox" />
            <span class="label-chip-small" style="background: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
          </label>
        `;
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

  // Drag and drop
  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', (event) => {
      draggedCardId = card.dataset.cardId;
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      draggedCardId = null;
      card.classList.remove('dragging');
      document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((zone) => {
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      zone.classList.add('drop-target');
      const dragging = zone.querySelector('.card.dragging');
      const closest = closestCardAfterCursor(zone, event.clientY);
      if (closest) {
        zone.insertBefore(dragging || document.querySelector('.card.dragging'), closest);
      } else {
        zone.appendChild(dragging || document.querySelector('.card.dragging'));
      }
    });
    zone.addEventListener('dragleave', (event) => {
      if (!zone.contains(event.relatedTarget)) zone.classList.remove('drop-target');
    });
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = zone.dataset.columnId;
      const { afterId, beforeId } = neighborIds(zone, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });

  // Label manager toggle
  const manageLabelBtn = document.getElementById('manage-labels-btn');
  if (manageLabelBtn) {
    manageLabelBtn.addEventListener('click', () => {
      document.getElementById('label-manager-overlay').classList.remove('hidden');
    });
  }
  const closeLabelManager = document.getElementById('close-label-manager');
  if (closeLabelManager) {
    closeLabelManager.addEventListener('click', () => {
      document.getElementById('label-manager-overlay').classList.add('hidden');
    });
  }
  // Click overlay to close
  const overlay = document.getElementById('label-manager-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  }

  // Create label form
  const createLabelForm = document.getElementById('create-label-form');
  if (createLabelForm) {
    createLabelForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = createLabelForm.elements.name;
      const colorInput = createLabelForm.elements.color;
      const name = nameInput.value.trim();
      const color = colorInput.value.trim();
      if (!name) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!resp.ok) {
          const data = await resp.json();
          setStatus(data.error || 'Failed to create label', true);
          return;
        }
        const label = await resp.json();
        allLabels.push(label);
        nameInput.value = '';
        render();
        // Re-open the label manager
        document.getElementById('label-manager-overlay').classList.remove('hidden');
      } catch (err) {
        setStatus(`Create label failed: ${err.message}`, true);
      }
    });
  }

  // Edit / delete label buttons
  document.querySelectorAll('.label-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => editLabel(btn.dataset.labelId));
  });
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => deleteLabel(btn.dataset.labelId));
  });

  // Card label button (open popup)
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      openLabelCardId = openLabelCardId === cardId ? null : cardId;
      render();
      // Re-open the popup's parent column
    });
  });

  // Close popup buttons
  document.querySelectorAll('.close-popup-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openLabelCardId = null;
      render();
    });
  });

  // Label assign/unassign checkboxes
  document.querySelectorAll('.label-assign-checkbox').forEach((cb) => {
    cb.addEventListener('change', async (e) => {
      e.stopPropagation();
      const cardId = cb.dataset.cardId;
      const labelId = cb.dataset.labelId;
      if (cb.checked) {
        await assignLabel(cardId, labelId);
      } else {
        await unassignLabel(cardId, labelId);
      }
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

  // Clear filters
  const clearBtn = document.getElementById('clear-filters');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilters.clear();
      render();
    });
  }

  // Close label popup when clicking outside
  document.addEventListener('click', (e) => {
    if (openLabelCardId && !e.target.closest('.label-popup') && !e.target.closest('.card-label-btn')) {
      openLabelCardId = null;
      render();
    }
  }, { once: true });
}

function closestCardAfterCursor(zone, y) {
  const cards = [...zone.querySelectorAll('.card:not(.dragging)')];
  let closest = null;
  let closestDistance = Infinity;
  for (const card of cards) {
    const mid = card.getBoundingClientRect().top + card.offsetHeight / 2;
    const distance = mid - y;
    if (distance > 0 && distance < closestDistance) {
      closestDistance = distance;
      closest = card;
    }
  }
  return closest;
}

function neighborIds(list, cardId) {
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
    board = normalizeBoard(await (await fetch(`${API_BASE}/api/board`)).json());
    render();
  }
}

async function editLabel(labelId) {
  const label = allLabels.find((l) => l.id === labelId);
  if (!label) return;
  const newName = prompt('New label name:', label.name);
  if (newName === null) return;
  if (newName.trim().length === 0) {
    setStatus('Label name cannot be empty', true);
    return;
  }
  const newColor = prompt('New color (hex, e.g. #ff0000):', label.color);
  if (newColor === null) return;
  if (!/^#[0-9a-fA-F]{6}$/.test(newColor.trim())) {
    setStatus('Invalid color format', true);
    return;
  }
  try {
    const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), color: newColor.trim() }),
    });
    if (!resp.ok) {
      const data = await resp.json();
      setStatus(data.error || 'Failed to update label', true);
      return;
    }
    const updated = await resp.json();
    const idx = allLabels.findIndex((l) => l.id === labelId);
    if (idx !== -1) allLabels[idx] = updated;
    // Board will be updated via SSE broadcast
  } catch (err) {
    setStatus(`Update label failed: ${err.message}`, true);
  }
}

async function deleteLabel(labelId) {
  if (!confirm('Delete this label? It will be removed from all cards.')) return;
  try {
    const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
    if (!resp.ok) {
      const data = await resp.json();
      setStatus(data.error || 'Failed to delete label', true);
      return;
    }
    allLabels = allLabels.filter((l) => l.id !== labelId);
    activeFilters.delete(labelId);
    // Board will be updated via SSE broadcast
  } catch (err) {
    setStatus(`Delete label failed: ${err.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const resp = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!resp.ok) {
      const data = await resp.json();
      setStatus(data.error || 'Failed to assign label', true);
    }
  } catch (err) {
    setStatus(`Assign label failed: ${err.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const resp = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
      method: 'DELETE',
    });
    if (!resp.ok) {
      const data = await resp.json();
      setStatus(data.error || 'Failed to unassign label', true);
    }
  } catch (err) {
    setStatus(`Unassign label failed: ${err.message}`, true);
  }
}

function applyMutation(message) {
  // Handle label-specific mutations
  if (message.type === 'label-created') {
    const exists = allLabels.find((l) => l.id === message.label.id);
    if (!exists) allLabels.push(message.label);
    allLabels.sort((a, b) => a.name.localeCompare(b.name));
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-updated') {
    const idx = allLabels.findIndex((l) => l.id === message.label.id);
    if (idx !== -1) allLabels[idx] = message.label;
    else allLabels.push(message.label);
    allLabels.sort((a, b) => a.name.localeCompare(b.name));
    if (message.board) board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-deleted') {
    allLabels = allLabels.filter((l) => l.id !== message.labelId);
    activeFilters.delete(message.labelId);
    if (message.board) board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-assigned' || message.type === 'label-unassigned') {
    if (message.board) {
      board = normalizeBoard(message.board);
      render();
      setStatus('Synced');
      return;
    }
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
  target.cards.push(card);
  target.cards.sort(compareCards);
  render();
  setStatus('Synced');
}

async function loadBoard() {
  const [boardResp, labelsResp] = await Promise.all([
    fetch(`${API_BASE}/api/board`),
    fetch(`${API_BASE}/api/labels`),
  ]);
  if (!boardResp.ok) throw new Error('Could not load board');
  if (!labelsResp.ok) throw new Error('Could not load labels');
  board = normalizeBoard(await boardResp.json());
  allLabels = await labelsResp.json();
  allLabels.sort((a, b) => a.name.localeCompare(b.name));
  render();
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
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
