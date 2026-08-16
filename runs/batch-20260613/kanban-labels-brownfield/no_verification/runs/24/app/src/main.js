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
let cardLabelPopupCardId = null;

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
  if (activeFilterLabelIds.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const filterId of activeFilterLabelIds) {
    if (cardLabelIds.has(filterId)) return true;
  }
  return false;
}

function textColorForBg(hex) {
  // Simple luminance check
  const c = hex.replace('#', '');
  const r = parseInt(c.length === 3 ? c[0]+c[0] : c.substring(0,2), 16);
  const g = parseInt(c.length === 3 ? c[1]+c[1] : c.substring(2,4), 16);
  const b = parseInt(c.length === 3 ? c[2]+c[2] : c.substring(4,6), 16);
  const lum = (0.299*r + 0.587*g + 0.114*b) / 255;
  return lum > 0.5 ? '#000000' : '#ffffff';
}

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <button id="manage-labels-btn" class="manage-labels-btn" title="Manage Labels">🏷️ Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    ${labelManagerOpen ? renderLabelManager() : ''}
    ${cardLabelPopupCardId ? renderCardLabelPopup() : ''}
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
      <span class="filter-bar-label">Filter by label:</span>
      ${allLabels.map((label) => {
        const active = activeFilterLabelIds.has(label.id);
        return `<button class="filter-chip ${active ? 'filter-chip-active' : ''}"
                  data-label-id="${escapeHtml(label.id)}"
                  style="background:${active ? escapeHtml(label.color) : '#e2e8f0'};color:${active ? textColorForBg(label.color) : '#334155'};border-color:${escapeHtml(label.color)}">
                  ${escapeHtml(label.name)}
                </button>`;
      }).join('')}
      ${activeFilterLabelIds.size > 0 ? '<button class="filter-clear-btn" id="clear-filter">✕ Clear</button>' : ''}
    </div>
  `;
}

function renderLabelManager() {
  return `
    <div class="modal-overlay" id="label-manager-overlay">
      <div class="modal label-manager-modal">
        <div class="modal-header">
          <h3>Manage Labels</h3>
          <button class="modal-close" id="close-label-manager">✕</button>
        </div>
        <form class="label-create-form" id="label-create-form">
          <input type="text" name="name" placeholder="Label name…" maxlength="50" autocomplete="off" required />
          <input type="color" name="color" value="#2563eb" />
          <button type="submit">Add</button>
        </form>
        <div class="label-list">
          ${allLabels.length === 0 ? '<p class="label-empty">No labels yet.</p>' : ''}
          ${allLabels.map((label) => `
            <div class="label-list-item" data-label-id="${escapeHtml(label.id)}">
              <span class="label-chip" style="background:${escapeHtml(label.color)};color:${textColorForBg(label.color)}">${escapeHtml(label.name)}</span>
              <div class="label-actions">
                <button class="label-edit-btn" data-label-id="${escapeHtml(label.id)}" title="Edit">✏️</button>
                <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete">🗑️</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderCardLabelPopup() {
  const found = findCard(cardLabelPopupCardId);
  if (!found) return '';
  const card = found.card;
  const assignedIds = new Set((card.labels || []).map((l) => l.id));
  return `
    <div class="modal-overlay" id="card-label-overlay">
      <div class="modal card-label-modal">
        <div class="modal-header">
          <h3>Labels for: ${escapeHtml(card.text.length > 40 ? card.text.slice(0,40)+'…' : card.text)}</h3>
          <button class="modal-close" id="close-card-label-popup">✕</button>
        </div>
        <div class="card-label-list">
          ${allLabels.length === 0 ? '<p class="label-empty">No labels yet. Create labels first.</p>' : ''}
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
  const labelsHtml = (card.labels || []).map((label) =>
    `<span class="label-chip label-chip-small" style="background:${escapeHtml(label.color)};color:${textColorForBg(label.color)}">${escapeHtml(label.name)}</span>`
  ).join('');
  return `
    <article class="card ${hidden ? 'card-hidden' : ''}" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml ? `<div class="card-labels">${labelsHtml}</div>` : ''}
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷️</button>
    </article>
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
  document.querySelectorAll('.card').forEach((el) => {
    el.addEventListener('dragstart', (event) => {
      draggedCardId = el.dataset.cardId;
      el.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      draggedCardId = null;
      document.querySelectorAll('.drop-target').forEach((z) => z.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((zone) => {
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      zone.classList.add('drop-target');
      const dragging = document.querySelector('.card.dragging');
      if (!dragging) return;
      const closestCard = getDragAfterElement(zone, event.clientY);
      if (closestCard) {
        zone.insertBefore(dragging, closestCard);
      } else {
        zone.appendChild(dragging);
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
      try {
        const response = await fetch(`${API_BASE}/api/cards/${draggedCardId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
      } catch (error) {
        setStatus(`Move failed: ${error.message}`, true);
        await loadBoard();
      }
    });
  });

  // Label manager button
  document.getElementById('manage-labels-btn')?.addEventListener('click', () => {
    labelManagerOpen = true;
    cardLabelPopupCardId = null;
    render();
  });

  // Close label manager
  document.getElementById('close-label-manager')?.addEventListener('click', () => {
    labelManagerOpen = false;
    render();
  });
  document.getElementById('label-manager-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'label-manager-overlay') {
      labelManagerOpen = false;
      render();
    }
  });

  // Create label form
  document.getElementById('label-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return;
    try {
      const resp = await fetch(`${API_BASE}/api/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color }),
      });
      if (!resp.ok) {
        const err = await resp.json();
        setStatus(err.error || 'Failed to create label', true);
        return;
      }
      const label = await resp.json();
      allLabels.push(label);
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
      render();
    } catch (error) {
      setStatus(`Label create failed: ${error.message}`, true);
    }
  });

  // Edit label buttons
  document.querySelectorAll('.label-edit-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const label = allLabels.find((l) => l.id === labelId);
      if (!label) return;
      const newName = prompt('Rename label:', label.name);
      if (newName === null) return;
      if (newName.trim().length === 0) { setStatus('Label name cannot be empty', true); return; }
      const newColor = prompt('New color (hex):', label.color);
      if (newColor === null) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName.trim(), color: newColor.trim() }),
        });
        if (!resp.ok) {
          const err = await resp.json();
          setStatus(err.error || 'Failed to update label', true);
          return;
        }
        await refreshLabelsAndBoard();
      } catch (error) {
        setStatus(`Label update failed: ${error.message}`, true);
      }
    });
  });

  // Delete label buttons
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const label = allLabels.find((l) => l.id === labelId);
      if (!label) return;
      if (!confirm(`Delete label "${label.name}"? It will be removed from all cards.`)) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
        if (!resp.ok) {
          const err = await resp.json();
          setStatus(err.error || 'Failed to delete label', true);
          return;
        }
        allLabels = allLabels.filter((l) => l.id !== labelId);
        activeFilterLabelIds.delete(labelId);
        await refreshBoard();
        render();
      } catch (error) {
        setStatus(`Label delete failed: ${error.message}`, true);
      }
    });
  });

  // Card label buttons (per-card)
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      cardLabelPopupCardId = btn.dataset.cardId;
      labelManagerOpen = false;
      render();
    });
  });

  // Close card label popup
  document.getElementById('close-card-label-popup')?.addEventListener('click', () => {
    cardLabelPopupCardId = null;
    render();
  });
  document.getElementById('card-label-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'card-label-overlay') {
      cardLabelPopupCardId = null;
      render();
    }
  });

  // Card label checkboxes
  document.querySelectorAll('.card-label-checkbox').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const cardId = cb.dataset.cardId;
      const labelId = cb.dataset.labelId;
      const assign = cb.checked;
      try {
        if (assign) {
          const resp = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId }),
          });
          if (!resp.ok) throw new Error('Assign failed');
        } else {
          const resp = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
            method: 'DELETE',
          });
          if (!resp.ok) throw new Error('Unassign failed');
        }
      } catch (error) {
        setStatus(`Label assignment failed: ${error.message}`, true);
        await refreshBoard();
        render();
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
}

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

function applyMutation(message) {
  // Handle label-specific mutations
  if (message.type === 'label-created') {
    const label = message.label;
    if (label && !allLabels.find((l) => l.id === label.id)) {
      allLabels.push(label);
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-updated') {
    const label = message.label;
    if (label) {
      const idx = allLabels.findIndex((l) => l.id === label.id);
      if (idx !== -1) allLabels[idx] = label;
      else allLabels.push(label);
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
    activeFilterLabelIds.delete(message.labelId);
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'card-label-assigned' || message.type === 'card-label-unassigned') {
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
  target.cards.push(card);
  target.cards.sort(compareCards);
  render();
  setStatus('Synced');
}

async function refreshLabelsAndBoard() {
  const [labelsResp, boardResp] = await Promise.all([
    fetch(`${API_BASE}/api/labels`),
    fetch(`${API_BASE}/api/board`),
  ]);
  if (labelsResp.ok) {
    allLabels = await labelsResp.json();
  }
  if (boardResp.ok) {
    board = normalizeBoard(await boardResp.json());
  }
  render();
}

async function refreshBoard() {
  const boardResp = await fetch(`${API_BASE}/api/board`);
  if (boardResp.ok) {
    board = normalizeBoard(await boardResp.json());
  }
}

async function loadBoard() {
  const [boardResp, labelsResp] = await Promise.all([
    fetch(`${API_BASE}/api/board`),
    fetch(`${API_BASE}/api/labels`),
  ]);
  if (!boardResp.ok) throw new Error('Could not load board');
  board = normalizeBoard(await boardResp.json());
  if (labelsResp.ok) {
    allLabels = await labelsResp.json();
  }
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
