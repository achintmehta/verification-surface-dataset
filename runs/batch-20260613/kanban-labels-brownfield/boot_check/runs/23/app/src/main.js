import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];
let activeFilters = new Set(); // label IDs currently selected for filtering
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelManagerOpen = false;
let cardLabelMenuCardId = null; // which card's label-assign menu is open

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
  if (allLabels.length === 0) return '';
  return `
    <div class="filter-bar">
      <span class="filter-label-text">Filter by label:</span>
      ${allLabels.map((label) => {
        const active = activeFilters.has(label.id);
        return `<button class="filter-chip ${active ? 'active' : ''}" data-label-id="${escapeHtml(label.id)}" style="--chip-color: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</button>`;
      }).join('')}
      ${activeFilters.size > 0 ? '<button class="filter-clear-btn">Clear filter</button>' : ''}
    </div>
  `;
}

function renderLabelManager() {
  return `
    <div class="label-manager-overlay" id="label-manager-overlay">
      <div class="label-manager">
        <div class="label-manager-header">
          <h3>Manage Labels</h3>
          <button class="label-manager-close" id="label-manager-close">&times;</button>
        </div>
        <form class="label-create-form" id="label-create-form">
          <input type="text" name="name" placeholder="Label name…" maxlength="50" autocomplete="off" required />
          <input type="color" name="color" value="#2563eb" />
          <button type="submit">Create</button>
        </form>
        <div class="label-list">
          ${allLabels.length === 0 ? '<p class="label-empty">No labels yet.</p>' : ''}
          ${allLabels.map((label) => `
            <div class="label-item" data-label-id="${escapeHtml(label.id)}">
              <span class="label-chip-preview" style="background: ${escapeHtml(label.color)}"></span>
              <input type="text" class="label-name-input" value="${escapeHtml(label.name)}" data-label-id="${escapeHtml(label.id)}" />
              <input type="color" class="label-color-input" value="${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}" />
              <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete label">&times;</button>
            </div>
          `).join('')}
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

function renderCard(card, columnId) {
  const visible = cardPassesFilter(card);
  const labels = card.labels || [];
  const isLabelMenuOpen = cardLabelMenuCardId === card.id;
  return `
    <article class="card ${!visible ? 'card-filtered' : ''}" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labels.length > 0 ? `<div class="card-labels">${labels.map((l) => `<span class="card-label-chip" style="background: ${escapeHtml(l.color)}" title="${escapeHtml(l.name)}" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(l.id)}">${escapeHtml(l.name)}<span class="chip-remove" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(l.id)}">&times;</span></span>`).join('')}</div>` : ''}
      <button class="card-add-label-btn" data-card-id="${escapeHtml(card.id)}" title="Assign label">+🏷️</button>
      ${isLabelMenuOpen ? renderCardLabelMenu(card) : ''}
    </article>
  `;
}

function renderCardLabelMenu(card) {
  const assignedIds = (card.labels || []).map((l) => l.id);
  if (allLabels.length === 0) {
    return `<div class="card-label-menu"><p class="label-empty">No labels. Create one first.</p></div>`;
  }
  return `
    <div class="card-label-menu">
      ${allLabels.map((label) => {
        const assigned = assignedIds.includes(label.id);
        return `<button class="card-label-option ${assigned ? 'assigned' : ''}" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}">
          <span class="card-label-chip-sm" style="background: ${escapeHtml(label.color)}"></span>
          ${escapeHtml(label.name)}
          ${assigned ? ' ✓' : ''}
        </button>`;
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

  // Label manager overlay close
  document.getElementById('label-manager-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'label-manager-overlay') { labelManagerOpen = false; render(); }
  });
  document.getElementById('label-manager-close')?.addEventListener('click', () => {
    labelManagerOpen = false;
    render();
  });

  // Label create form
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
        setStatus(`Label error: ${err.error}`, true);
        return;
      }
      form.elements.name.value = '';
    } catch (err) {
      setStatus(`Label create failed: ${err.message}`, true);
    }
  });

  // Label rename (on blur)
  document.querySelectorAll('.label-name-input').forEach((input) => {
    input.addEventListener('change', async () => {
      const id = input.dataset.labelId;
      const name = input.value.trim();
      if (!name) return;
      await updateLabel(id, { name });
    });
  });

  // Label recolor
  document.querySelectorAll('.label-color-input').forEach((input) => {
    input.addEventListener('change', async () => {
      const id = input.dataset.labelId;
      const color = input.value;
      await updateLabel(id, { color });
    });
  });

  // Label delete
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.labelId;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
        if (!resp.ok) setStatus('Delete label failed', true);
      } catch (err) {
        setStatus(`Delete label failed: ${err.message}`, true);
      }
    });
  });

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const labelId = btn.dataset.labelId;
      if (activeFilters.has(labelId)) {
        activeFilters.delete(labelId);
      } else {
        activeFilters.add(labelId);
      }
      render();
    });
  });
  document.querySelector('.filter-clear-btn')?.addEventListener('click', () => {
    activeFilters.clear();
    render();
  });

  // Card add-label button
  document.querySelectorAll('.card-add-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      cardLabelMenuCardId = cardLabelMenuCardId === cardId ? null : cardId;
      render();
    });
  });

  // Card label menu options (assign/unassign)
  document.querySelectorAll('.card-label-option').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      const labelId = btn.dataset.labelId;
      const isAssigned = btn.classList.contains('assigned');
      try {
        if (isAssigned) {
          await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
        } else {
          await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId }),
          });
        }
      } catch (err) {
        setStatus(`Label assign failed: ${err.message}`, true);
      }
    });
  });

  // Card label chip remove
  document.querySelectorAll('.chip-remove').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      const labelId = btn.dataset.labelId;
      try {
        await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
      } catch (err) {
        setStatus(`Label unassign failed: ${err.message}`, true);
      }
    });
  });

  // Close card label menu on outside click
  document.addEventListener('click', (e) => {
    if (cardLabelMenuCardId && !e.target.closest('.card-label-menu') && !e.target.closest('.card-add-label-btn')) {
      cardLabelMenuCardId = null;
      render();
    }
  }, { once: true });

  // Add-card forms
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

  // Drag-and-drop
  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', (event) => {
      draggedCardId = card.dataset.cardId;
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      draggedCardId = null;
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      list.classList.add('drop-target');
      const dragging = document.querySelector('.card.dragging');
      if (!dragging) return;
      const after = getDragAfterElement(list, event.clientY);
      if (after) list.insertBefore(dragging, after);
      else list.appendChild(dragging);
    });

    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));

    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      if (!draggedCardId) return;
      const cardId = draggedCardId;
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
        if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
      } catch (error) {
        setStatus(`Move failed: ${error.message}`, true);
        board = normalizeBoard(await (await fetch(`${API_BASE}/api/board`)).json());
        render();
      }
    });
  });
}

function getDragAfterElement(container, y) {
  const els = [...container.querySelectorAll('.card:not(.dragging)')];
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

async function updateLabel(id, data) {
  try {
    const resp = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!resp.ok) {
      const err = await resp.json();
      setStatus(`Label update failed: ${err.error}`, true);
    }
  } catch (err) {
    setStatus(`Label update failed: ${err.message}`, true);
  }
}

function applyMutation(message) {
  // Handle label mutations
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
