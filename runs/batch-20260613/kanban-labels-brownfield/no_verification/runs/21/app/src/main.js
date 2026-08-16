import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];
let activeFilterLabelIds = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelManagerOpen = false;
let cardLabelMenuOpenForCardId = null;

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

// ---- Filtering ----

function cardMatchesFilter(card) {
  if (activeFilterLabelIds.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const filterId of activeFilterLabelIds) {
    if (cardLabelIds.has(filterId)) return true;
  }
  return false;
}

// ---- Contrast color for label chips ----

function textColorForBg(hex) {
  let c = hex.replace('#', '');
  if (c.length === 3) c = c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
  const r = parseInt(c.substring(0,2), 16);
  const g = parseInt(c.substring(2,4), 16);
  const b = parseInt(c.substring(4,6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

// ---- Render ----

function render() {
  const filterBarHtml = renderFilterBar();
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-right">
        <button id="manage-labels-btn" class="manage-labels-btn">Manage Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${filterBarHtml}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${labelManagerOpen ? renderLabelManager() : ''}
    ${cardLabelMenuOpenForCardId ? renderCardLabelMenu() : ''}
  `;
  bindEvents();
}

function renderFilterBar() {
  if (allLabels.length === 0) return '';
  return `
    <div class="filter-bar">
      <span class="filter-bar-label">Filter by label:</span>
      ${allLabels.map((label) => {
        const active = activeFilterLabelIds.has(label.id);
        return `<button class="filter-chip ${active ? 'active' : ''}" data-label-id="${escapeHtml(label.id)}"
          style="background:${active ? escapeHtml(label.color) : '#e2e8f0'};color:${active ? textColorForBg(label.color) : '#334155'};border-color:${escapeHtml(label.color)}">
          ${escapeHtml(label.name)}
        </button>`;
      }).join('')}
      ${activeFilterLabelIds.size > 0 ? '<button class="filter-clear-btn" id="clear-filter">Clear</button>' : ''}
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
        ${column.cards.map((card) => renderCard(card, !cardMatchesFilter(card))).join('')}
      </div>
    </section>
  `;
}

function renderCard(card, hidden) {
  const labelsHtml = (card.labels || []).map((label) =>
    `<span class="label-chip" style="background:${escapeHtml(label.color)};color:${textColorForBg(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`
  ).join('');

  return `
    <article class="card ${hidden ? 'card-hidden' : ''}" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml ? `<div class="card-labels">${labelsHtml}</div>` : ''}
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷</button>
    </article>
  `;
}

function renderLabelManager() {
  return `
    <div class="modal-overlay" id="label-manager-overlay">
      <div class="modal" id="label-manager">
        <div class="modal-header">
          <h3>Manage Labels</h3>
          <button class="modal-close" id="close-label-manager">✕</button>
        </div>
        <div class="modal-body">
          <form class="label-create-form" id="label-create-form">
            <input type="text" name="label-name" placeholder="Label name" maxlength="50" autocomplete="off" required />
            <input type="color" name="label-color" value="#2563eb" />
            <button type="submit">Create</button>
          </form>
          <div class="label-list" id="label-list">
            ${allLabels.length === 0 ? '<p class="no-labels">No labels yet.</p>' : ''}
            ${allLabels.map((label) => `
              <div class="label-row" data-label-id="${escapeHtml(label.id)}">
                <span class="label-chip-preview" style="background:${escapeHtml(label.color)};color:${textColorForBg(label.color)}">${escapeHtml(label.name)}</span>
                <input type="text" class="label-edit-name" value="${escapeHtml(label.name)}" data-label-id="${escapeHtml(label.id)}" />
                <input type="color" class="label-edit-color" value="${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}" />
                <button class="label-save-btn" data-label-id="${escapeHtml(label.id)}">Save</button>
                <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}">Delete</button>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderCardLabelMenu() {
  const found = findCard(cardLabelMenuOpenForCardId);
  if (!found) { cardLabelMenuOpenForCardId = null; return ''; }
  const card = found.card;
  const assignedIds = new Set((card.labels || []).map((l) => l.id));

  return `
    <div class="modal-overlay" id="card-label-overlay">
      <div class="modal modal-small" id="card-label-menu">
        <div class="modal-header">
          <h3>Labels for card</h3>
          <button class="modal-close" id="close-card-label-menu">✕</button>
        </div>
        <div class="modal-body">
          ${allLabels.length === 0 ? '<p class="no-labels">No labels created yet.</p>' : ''}
          ${allLabels.map((label) => {
            const assigned = assignedIds.has(label.id);
            return `
              <div class="card-label-row">
                <label class="card-label-toggle">
                  <input type="checkbox" ${assigned ? 'checked' : ''} data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}" class="card-label-checkbox" />
                  <span class="label-chip" style="background:${escapeHtml(label.color)};color:${textColorForBg(label.color)}">${escapeHtml(label.name)}</span>
                </label>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;
}

// ---- Event binding ----

function bindEvents() {
  // Manage labels button
  document.getElementById('manage-labels-btn')?.addEventListener('click', () => {
    labelManagerOpen = true;
    render();
  });

  // Close label manager
  document.getElementById('close-label-manager')?.addEventListener('click', () => {
    labelManagerOpen = false;
    render();
  });
  document.getElementById('label-manager-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'label-manager-overlay') { labelManagerOpen = false; render(); }
  });

  // Create label form
  document.getElementById('label-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = e.target['label-name'].value.trim();
    const color = e.target['label-color'].value;
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
      const label = await resp.json();
      addLabelToState(label);
      render();
    } catch (err) {
      alert('Failed to create label: ' + err.message);
    }
  });

  // Label save buttons
  document.querySelectorAll('.label-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const row = btn.closest('.label-row');
      const name = row.querySelector('.label-edit-name').value.trim();
      const color = row.querySelector('.label-edit-color').value;
      if (!name) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!resp.ok) {
          const data = await resp.json();
          alert(data.error || 'Failed to update label');
          return;
        }
        const label = await resp.json();
        updateLabelInState(label);
        render();
      } catch (err) {
        alert('Failed to update label: ' + err.message);
      }
    });
  });

  // Label delete buttons
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      if (!confirm('Delete this label? It will be removed from all cards.')) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
        if (!resp.ok) {
          const data = await resp.json();
          alert(data.error || 'Failed to delete label');
          return;
        }
        removeLabelFromState(labelId);
        render();
      } catch (err) {
        alert('Failed to delete label: ' + err.message);
      }
    });
  });

  // Card label buttons (tag emoji button on cards)
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      cardLabelMenuOpenForCardId = btn.dataset.cardId;
      render();
    });
  });

  // Close card label menu
  document.getElementById('close-card-label-menu')?.addEventListener('click', () => {
    cardLabelMenuOpenForCardId = null;
    render();
  });
  document.getElementById('card-label-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'card-label-overlay') { cardLabelMenuOpenForCardId = null; render(); }
  });

  // Card label checkboxes
  document.querySelectorAll('.card-label-checkbox').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const cardId = cb.dataset.cardId;
      const labelId = cb.dataset.labelId;
      if (cb.checked) {
        await assignLabelToCard(cardId, labelId);
      } else {
        await unassignLabelFromCard(cardId, labelId);
      }
    });
  });

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const labelId = chip.dataset.labelId;
      if (activeFilterLabelIds.has(labelId)) {
        activeFilterLabelIds.delete(labelId);
      } else {
        activeFilterLabelIds.add(labelId);
      }
      render();
    });
  });

  // Clear filter
  document.getElementById('clear-filter')?.addEventListener('click', () => {
    activeFilterLabelIds.clear();
    render();
  });

  // ---- Existing card/column events ----
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

  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
    });
    cardEl.addEventListener('dragend', () => {
      draggedCardId = null;
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      list.classList.add('drop-target');
      const after = getDragAfterElement(list, event.clientY);
      const dragging = document.querySelector('.card.dragging');
      if (!dragging) return;
      if (after == null) {
        list.appendChild(dragging);
      } else {
        list.insertBefore(dragging, after);
      }
    });
    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) list.classList.remove('drop-target');
    });
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      const cardId = event.dataTransfer.getData('text/plain');
      if (!cardId) return;
      const columnId = list.dataset.columnId;
      const { afterId, beforeId } = getNeighborIds(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
      try {
        const response = await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Move failed');
        }
      } catch (error) {
        setStatus(`Move failed: ${error.message}`, true);
        await loadBoard();
      }
    });
  });
}

function getDragAfterElement(list, y) {
  const cards = [...list.querySelectorAll('.card:not(.dragging)')];
  let closest = null;
  let closestOffset = Number.NEGATIVE_INFINITY;
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = card;
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

// ---- Label state helpers ----

function addLabelToState(label) {
  const exists = allLabels.find((l) => l.id === label.id);
  if (!exists) {
    allLabels.push(label);
    allLabels.sort((a, b) => a.name.localeCompare(b.name));
  }
}

function updateLabelInState(label) {
  const idx = allLabels.findIndex((l) => l.id === label.id);
  if (idx !== -1) {
    allLabels[idx] = label;
  } else {
    allLabels.push(label);
  }
  allLabels.sort((a, b) => a.name.localeCompare(b.name));

  // Update label info on all cards
  for (const col of board.columns) {
    for (const card of col.cards) {
      if (card.labels) {
        for (let i = 0; i < card.labels.length; i++) {
          if (card.labels[i].id === label.id) {
            card.labels[i] = { ...label };
          }
        }
      }
    }
  }
}

function removeLabelFromState(labelId) {
  allLabels = allLabels.filter((l) => l.id !== labelId);
  activeFilterLabelIds.delete(labelId);

  // Remove from all cards
  for (const col of board.columns) {
    for (const card of col.cards) {
      if (card.labels) {
        card.labels = card.labels.filter((l) => l.id !== labelId);
      }
    }
  }
}

function assignLabelInState(cardId, label) {
  for (const col of board.columns) {
    for (const card of col.cards) {
      if (card.id === cardId) {
        if (!card.labels) card.labels = [];
        if (!card.labels.find((l) => l.id === label.id)) {
          card.labels.push(label);
          card.labels.sort((a, b) => a.name.localeCompare(b.name));
        }
        return;
      }
    }
  }
}

function unassignLabelInState(cardId, labelId) {
  for (const col of board.columns) {
    for (const card of col.cards) {
      if (card.id === cardId) {
        if (card.labels) {
          card.labels = card.labels.filter((l) => l.id !== labelId);
        }
        return;
      }
    }
  }
}

// ---- API calls ----

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

async function assignLabelToCard(cardId, labelId) {
  try {
    const resp = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!resp.ok) throw new Error((await resp.json()).error || 'Assign failed');
    const data = await resp.json();
    assignLabelInState(cardId, data.label);
    render();
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
  }
}

async function unassignLabelFromCard(cardId, labelId) {
  try {
    const resp = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
      method: 'DELETE',
    });
    if (!resp.ok) throw new Error((await resp.json()).error || 'Unassign failed');
    unassignLabelInState(cardId, labelId);
    render();
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
  }
}

// ---- Mutation handler ----

function applyMutation(message) {
  // Handle board-level mutations (create, move) — existing behavior
  if (message.type === 'create' || message.type === 'move') {
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
    return;
  }

  // Label mutations
  if (message.type === 'label-created') {
    addLabelToState(message.label);
    render();
    setStatus('Synced');
    return;
  }
  if (message.type === 'label-updated') {
    updateLabelInState(message.label);
    render();
    setStatus('Synced');
    return;
  }
  if (message.type === 'label-deleted') {
    removeLabelFromState(message.labelId);
    render();
    setStatus('Synced');
    return;
  }
  if (message.type === 'label-assigned') {
    assignLabelInState(message.cardId, message.label);
    render();
    setStatus('Synced');
    return;
  }
  if (message.type === 'label-unassigned') {
    unassignLabelInState(message.cardId, message.labelId);
    render();
    setStatus('Synced');
    return;
  }

  // Fallback: legacy messages without a type field
  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (message.card) {
    const card = message.card;
    removeCardEverywhere(card.id);
    const target = board.columns.find((column) => column.id === card.column_id || column.id === message.columnId);
    if (!target) return;
    target.cards.push({ ...card, labels: card.labels || [] });
    target.cards.sort(compareCards);
    render();
    setStatus('Synced');
  }
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
