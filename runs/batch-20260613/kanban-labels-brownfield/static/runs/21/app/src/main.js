import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilters = new Set(); // label IDs for filtering
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelManagerOpen = false;
let cardLabelMenuOpen = null; // card ID whose label menu is open

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

function cardPassesFilter(card) {
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
        <button id="manage-labels-btn" class="manage-labels-btn" title="Manage Labels">🏷️ Labels</button>
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
  if (labels.length === 0) return '';
  return `
    <div class="filter-bar">
      <span class="filter-label">Filter by label:</span>
      ${labels.map((label) => {
        const active = activeFilters.has(label.id);
        return `<button class="filter-chip ${active ? 'active' : ''}" data-label-id="${escapeHtml(label.id)}" style="--chip-color: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</button>`;
      }).join('')}
      ${activeFilters.size > 0 ? '<button class="filter-clear" id="clear-filters">Clear</button>' : ''}
    </div>
  `;
}

function renderLabelManager() {
  return `
    <div class="label-manager-backdrop" id="label-manager-backdrop">
      <div class="label-manager">
        <div class="label-manager-header">
          <h3>Manage Labels</h3>
          <button class="label-manager-close" id="label-manager-close">✕</button>
        </div>
        <form class="label-create-form" id="label-create-form">
          <input type="text" name="name" placeholder="Label name…" maxlength="50" autocomplete="off" required />
          <input type="color" name="color" value="#2563eb" />
          <button type="submit">Add</button>
        </form>
        <ul class="label-list">
          ${labels.map((label) => `
            <li class="label-item" data-label-id="${escapeHtml(label.id)}">
              <span class="label-chip" style="background: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
              <div class="label-actions">
                <button class="label-edit-btn" data-label-id="${escapeHtml(label.id)}" title="Edit">✏️</button>
                <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete">🗑️</button>
              </div>
            </li>
          `).join('')}
          ${labels.length === 0 ? '<li class="label-empty">No labels yet</li>' : ''}
        </ul>
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
        ${column.cards.map((card) => renderCard(card, column)).join('')}
      </div>
    </section>
  `;
}

function renderCard(card, column) {
  const hidden = !cardPassesFilter(card) ? ' card-hidden' : '';
  const cardLabels = card.labels || [];
  const isMenuOpen = cardLabelMenuOpen === card.id;
  return `
    <article class="card${hidden}" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${cardLabels.length > 0 ? `
        <div class="card-labels">
          ${cardLabels.map((l) => `<span class="card-label-chip" style="background: ${escapeHtml(l.color)}" title="${escapeHtml(l.name)}">${escapeHtml(l.name)}</span>`).join('')}
        </div>
      ` : ''}
      <button class="card-label-toggle" data-card-id="${escapeHtml(card.id)}" title="Assign labels">🏷️</button>
      ${isMenuOpen ? renderCardLabelMenu(card) : ''}
    </article>
  `;
}

function renderCardLabelMenu(card) {
  const assigned = new Set((card.labels || []).map((l) => l.id));
  return `
    <div class="card-label-menu" data-card-id="${escapeHtml(card.id)}">
      <div class="card-label-menu-header">Assign Labels</div>
      ${labels.length === 0 ? '<div class="card-label-menu-empty">No labels created</div>' : ''}
      ${labels.map((label) => {
        const checked = assigned.has(label.id);
        return `
          <label class="card-label-option">
            <input type="checkbox" ${checked ? 'checked' : ''} data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}" class="card-label-checkbox" />
            <span class="card-label-chip-small" style="background: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
          </label>
        `;
      }).join('')}
    </div>
  `;
}

function bindEvents() {
  // Manage labels button
  document.getElementById('manage-labels-btn')?.addEventListener('click', () => {
    labelManagerOpen = !labelManagerOpen;
    render();
  });

  // Label manager close
  document.getElementById('label-manager-close')?.addEventListener('click', () => {
    labelManagerOpen = false;
    render();
  });

  // Label manager backdrop click
  document.getElementById('label-manager-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'label-manager-backdrop') {
      labelManagerOpen = false;
      render();
    }
  });

  // Label create form
  document.getElementById('label-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return;
    await createLabel(name, color);
    form.elements.name.value = '';
  });

  // Label edit buttons
  document.querySelectorAll('.label-edit-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const label = labels.find((l) => l.id === labelId);
      if (!label) return;
      const newName = prompt('Rename label:', label.name);
      if (newName === null) return;
      const newColor = prompt('New color (hex):', label.color);
      if (newColor === null) return;
      await updateLabel(labelId, newName.trim(), newColor.trim());
    });
  });

  // Label delete buttons
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      if (!confirm('Delete this label? It will be removed from all cards.')) return;
      await deleteLabel(labelId);
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
  document.getElementById('clear-filters')?.addEventListener('click', () => {
    activeFilters.clear();
    render();
  });

  // Card label toggle buttons
  document.querySelectorAll('.card-label-toggle').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      cardLabelMenuOpen = cardLabelMenuOpen === cardId ? null : cardId;
      render();
    });
  });

  // Card label checkboxes
  document.querySelectorAll('.card-label-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('change', async (e) => {
      const cardId = checkbox.dataset.cardId;
      const labelId = checkbox.dataset.labelId;
      if (checkbox.checked) {
        await assignLabel(cardId, labelId);
      } else {
        await unassignLabel(cardId, labelId);
      }
    });
  });

  // Close card label menu when clicking outside
  document.addEventListener('click', (e) => {
    if (cardLabelMenuOpen && !e.target.closest('.card-label-menu') && !e.target.closest('.card-label-toggle')) {
      cardLabelMenuOpen = null;
      render();
    }
  }, { once: true });

  // Existing event bindings
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
      const dragging = document.querySelector('.card.dragging');
      const afterEl = getDropTarget(list, event.clientY);
      if (!dragging) return;
      if (afterEl) list.insertBefore(dragging, afterEl);
      else list.appendChild(dragging);
    });
    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) list.classList.remove('drop-target');
    });
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = list.dataset.columnId;
      const { afterId, beforeId } = getNeighbours(list, draggedCardId);
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
        board = normalizeBoard(await (await fetch(`${API_BASE}/api/board`)).json());
        render();
      }
    });
  });
}

function getDropTarget(list, y) {
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

function getNeighbours(list, cardId) {
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

// --- Label API calls ---

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Create label failed');
    }
    await loadLabels();
    render();
  } catch (error) {
    setStatus(`Label error: ${error.message}`, true);
  }
}

async function updateLabel(id, name, color) {
  try {
    const body = {};
    if (name) body.name = name;
    if (color) body.color = color;
    const response = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Update label failed');
    }
    await loadLabels();
    board = normalizeBoard(await (await fetch(`${API_BASE}/api/board`)).json());
    render();
  } catch (error) {
    setStatus(`Label error: ${error.message}`, true);
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Delete label failed');
    }
    activeFilters.delete(id);
    await loadLabels();
    board = normalizeBoard(await (await fetch(`${API_BASE}/api/board`)).json());
    render();
  } catch (error) {
    setStatus(`Label error: ${error.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Assign label failed');
    }
  } catch (error) {
    setStatus(`Label error: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Unassign label failed');
    }
  } catch (error) {
    setStatus(`Label error: ${error.message}`, true);
  }
}

async function loadLabels() {
  const response = await fetch(`${API_BASE}/api/labels`);
  if (response.ok) {
    labels = await response.json();
  }
}

// --- Mutations ---

function applyMutation(message) {
  // Handle label-specific mutations
  if (message.type === 'label-created') {
    // Add the new label if not already present
    if (!labels.find((l) => l.id === message.label.id)) {
      labels.push(message.label);
      labels.sort((a, b) => a.name.localeCompare(b.name));
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-updated') {
    const idx = labels.findIndex((l) => l.id === message.label.id);
    if (idx !== -1) {
      labels[idx] = message.label;
      labels.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-deleted') {
    labels = labels.filter((l) => l.id !== message.labelId);
    activeFilters.delete(message.labelId);
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

  // Existing mutation handling
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
