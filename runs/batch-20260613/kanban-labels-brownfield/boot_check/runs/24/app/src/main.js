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
let cardLabelMenuCardId = null; // which card's label assignment menu is open

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
  const cardLabelIds = (card.labels || []).map((l) => l.id);
  for (const filterId of activeFilterLabelIds) {
    if (cardLabelIds.includes(filterId)) return true;
  }
  return false;
}

function getContrastColor(hexColor) {
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.length === 3 ? hex[0] + hex[0] : hex.substring(0, 2), 16);
  const g = parseInt(hex.length === 3 ? hex[1] + hex[1] : hex.substring(2, 4), 16);
  const b = parseInt(hex.length === 3 ? hex[2] + hex[2] : hex.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <button class="manage-labels-btn" id="manage-labels-btn">🏷️ Labels</button>
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
      <span class="filter-bar-label">Filter by label:</span>
      ${allLabels.map((label) => {
        const active = activeFilterLabelIds.has(label.id);
        return `<button class="filter-chip ${active ? 'active' : ''}" data-label-id="${escapeHtml(label.id)}"
          style="background:${active ? escapeHtml(label.color) : '#e2e8f0'}; color:${active ? getContrastColor(label.color) : '#334155'}; border-color:${escapeHtml(label.color)}">
          ${escapeHtml(label.name)}
        </button>`;
      }).join('')}
      ${activeFilterLabelIds.size > 0 ? '<button class="filter-clear" id="filter-clear">Clear filter</button>' : ''}
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
          <input name="name" type="text" placeholder="Label name…" autocomplete="off" required />
          <input name="color" type="color" value="#2563eb" />
          <button type="submit">Add</button>
        </form>
        <div class="label-list">
          ${allLabels.map((label) => `
            <div class="label-item" data-label-id="${escapeHtml(label.id)}">
              <span class="label-chip-preview" style="background:${escapeHtml(label.color)};color:${getContrastColor(label.color)}">${escapeHtml(label.name)}</span>
              <input class="label-edit-name" type="text" value="${escapeHtml(label.name)}" data-label-id="${escapeHtml(label.id)}" />
              <input class="label-edit-color" type="color" value="${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}" />
              <button class="label-save-btn" data-label-id="${escapeHtml(label.id)}" title="Save">💾</button>
              <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete">🗑️</button>
            </div>
          `).join('')}
          ${allLabels.length === 0 ? '<p class="no-labels">No labels yet.</p>' : ''}
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
        ${column.cards.map((card) => renderCard(card, !cardMatchesFilter(card))).join('')}
      </div>
    </section>
  `;
}

function renderCard(card, hidden) {
  const labelsHtml = (card.labels || []).map((label) =>
    `<span class="card-label-chip" style="background:${escapeHtml(label.color)};color:${getContrastColor(label.color)}">${escapeHtml(label.name)}</span>`
  ).join('');

  const labelMenuHtml = cardLabelMenuCardId === card.id ? renderCardLabelMenu(card) : '';

  return `
    <article class="card ${hidden ? 'card-hidden' : ''}" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml ? `<div class="card-labels">${labelsHtml}</div>` : ''}
      <button class="card-label-toggle" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷️</button>
      ${labelMenuHtml}
    </article>
  `;
}

function renderCardLabelMenu(card) {
  const cardLabelIds = (card.labels || []).map((l) => l.id);
  if (allLabels.length === 0) {
    return `<div class="card-label-menu"><p class="no-labels">No labels. Create some first.</p></div>`;
  }
  return `
    <div class="card-label-menu">
      ${allLabels.map((label) => {
        const assigned = cardLabelIds.includes(label.id);
        return `<label class="card-label-option">
          <input type="checkbox" ${assigned ? 'checked' : ''} data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}" class="card-label-checkbox" />
          <span class="card-label-chip-small" style="background:${escapeHtml(label.color)};color:${getContrastColor(label.color)}">${escapeHtml(label.name)}</span>
        </label>`;
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
      const columnId = form.dataset.columnId;
      input.value = '';
      await createCard(columnId, text);
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
      const { afterId, beforeId } = resolveNeighbours(list, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      const cardId = draggedCardId;
      draggedCardId = null;
      try {
        await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
      } catch (err) {
        setStatus('Move failed: ' + err.message, true);
      }
    });
  });

  // Label manager button
  document.getElementById('manage-labels-btn')?.addEventListener('click', () => {
    labelManagerOpen = !labelManagerOpen;
    render();
  });

  // Label manager close
  document.getElementById('label-manager-close')?.addEventListener('click', () => {
    labelManagerOpen = false;
    render();
  });

  // Click overlay to close
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
        setStatus(err.error || 'Create label failed', true);
        return;
      }
      const label = await resp.json();
      allLabels.push(label);
      render();
    } catch (err) {
      setStatus('Create label failed: ' + err.message, true);
    }
  });

  // Save label edits
  document.querySelectorAll('.label-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const nameInput = document.querySelector(`.label-edit-name[data-label-id="${labelId}"]`);
      const colorInput = document.querySelector(`.label-edit-color[data-label-id="${labelId}"]`);
      const name = nameInput?.value?.trim();
      const color = colorInput?.value;
      if (!name) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!resp.ok) {
          const err = await resp.json();
          setStatus(err.error || 'Update label failed', true);
          return;
        }
        const updated = await resp.json();
        const idx = allLabels.findIndex((l) => l.id === labelId);
        if (idx !== -1) allLabels[idx] = updated;
        render();
      } catch (err) {
        setStatus('Update label failed: ' + err.message, true);
      }
    });
  });

  // Delete label
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
        if (!resp.ok) {
          const err = await resp.json();
          setStatus(err.error || 'Delete label failed', true);
          return;
        }
        allLabels = allLabels.filter((l) => l.id !== labelId);
        activeFilterLabelIds.delete(labelId);
        render();
      } catch (err) {
        setStatus('Delete label failed: ' + err.message, true);
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
  document.getElementById('filter-clear')?.addEventListener('click', () => {
    activeFilterLabelIds.clear();
    render();
  });

  // Card label toggle buttons
  document.querySelectorAll('.card-label-toggle').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      cardLabelMenuCardId = cardLabelMenuCardId === cardId ? null : cardId;
      render();
    });
  });

  // Card label checkboxes
  document.querySelectorAll('.card-label-checkbox').forEach((cb) => {
    cb.addEventListener('change', async (e) => {
      e.stopPropagation();
      const cardId = cb.dataset.cardId;
      const labelId = cb.dataset.labelId;
      try {
        if (cb.checked) {
          await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId }),
          });
        } else {
          await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
            method: 'DELETE',
          });
        }
      } catch (err) {
        setStatus('Label assign failed: ' + err.message, true);
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

function positionGhost(event, list) {
  const cards = [...list.querySelectorAll('.card:not(.dragging)')];
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (event.clientY < rect.top + rect.height / 2) {
      list.insertBefore(document.querySelector(`.card[data-card-id="${draggedCardId}"]`) || document.createElement('div'), card);
      return;
    }
  }
  const dragging = document.querySelector(`.card[data-card-id="${draggedCardId}"]`);
  if (dragging) list.appendChild(dragging);
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
    if (message.label) {
      const idx = allLabels.findIndex((l) => l.id === message.label.id);
      if (idx !== -1) allLabels[idx] = message.label;
      else allLabels.push(message.label);
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
    if (message.labelId) {
      allLabels = allLabels.filter((l) => l.id !== message.labelId);
      activeFilterLabelIds.delete(message.labelId);
    }
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

  // Original mutation handling (create, move)
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
