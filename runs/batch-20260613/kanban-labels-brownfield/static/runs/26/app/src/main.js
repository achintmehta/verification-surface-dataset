import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];
let selectedLabelIds = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelManagerOpen = false;

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

function getFilteredBoard() {
  if (selectedLabelIds.size === 0) return board;
  return {
    columns: board.columns.map((column) => ({
      ...column,
      cards: column.cards.filter((card) =>
        (card.labels || []).some((label) => selectedLabelIds.has(label.id))
      ),
    })),
  };
}

function renderLabelFilterChip(label) {
  const selected = selectedLabelIds.has(label.id);
  return `
    <button class="label-chip filter-chip ${selected ? 'selected' : ''}" data-label-id="${escapeHtml(label.id)}" style="--label-color: ${escapeHtml(label.color)}">
      <span class="chip-color" style="background: ${escapeHtml(label.color)}"></span>
      ${escapeHtml(label.name)}
    </button>
  `;
}

function renderLabelManager() {
  return `
    <div class="modal-overlay" id="label-modal">
      <div class="modal">
        <div class="modal-header">
          <h2>Manage Labels</h2>
          <button class="close-btn" id="close-label-manager">&times;</button>
        </div>
        <div class="label-list">
          ${allLabels.length === 0 ? '<p class="empty">No labels created yet.</p>' : allLabels.map(renderLabelRow).join('')}
        </div>
        <form id="create-label-form" class="create-label-form">
          <input name="name" type="text" placeholder="Label name" maxlength="50" required />
          <input name="color" type="color" value="#3b82f6" />
          <button type="submit">Create</button>
        </form>
      </div>
    </div>
  `;
}

function renderLabelRow(label) {
  return `
    <div class="label-row" data-label-id="${escapeHtml(label.id)}">
      <span class="label-chip" style="--label-color: ${escapeHtml(label.color)}">
        <span class="chip-color" style="background: ${escapeHtml(label.color)}"></span>
        ${escapeHtml(label.name)}
      </span>
      <div class="label-actions">
        <button class="edit-label-btn" data-action="rename">Rename</button>
        <button class="edit-label-btn" data-action="recolor">Recolor</button>
        <button class="edit-label-btn danger" data-action="delete">Delete</button>
      </div>
    </div>
  `;
}

function render() {
  const filteredBoard = getFilteredBoard();
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <button id="manage-labels-btn" class="manage-btn">Manage Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    <div class="filter-bar">
      <span class="filter-label">Filter by labels:</span>
      <div class="label-filters">
        ${allLabels.length === 0 ? '<span class="no-labels">No labels yet</span>' : allLabels.map(renderLabelFilterChip).join('')}
      </div>
      ${selectedLabelIds.size > 0 ? '<button id="clear-filter-btn" class="clear-filter">Clear</button>' : ''}
    </div>
    <main class="board">
      ${filteredBoard.columns.map(renderColumn).join('')}
    </main>
    ${labelManagerOpen ? renderLabelManager() : ''}
  `;
  bindEvents();
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
  const chips = (card.labels || []).map((label) => `
    <span class="label-chip small" style="--label-color: ${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}">
      <span class="chip-color" style="background: ${escapeHtml(label.color)}"></span>
      ${escapeHtml(label.name)}
    </span>
  `).join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-labels">${chips}</div>
      <div class="card-label-actions">
        <button class="assign-label-btn" data-card-id="${escapeHtml(card.id)}" title="Assign labels">🏷️</button>
      </div>
    </article>
  `;
}

function bindEvents() {
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
      cardEl.classList.remove('dragging');
      draggedCardId = null;
      document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      list.classList.add('drop-target');
      const afterElement = getDragAfterElement(list, event.clientY);
      const dragging = document.querySelector('.dragging');
      if (!dragging) return;
      if (afterElement == null) list.appendChild(dragging);
      else list.insertBefore(dragging, afterElement);
    });
    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
      if (!cardId) return;
      const columnId = list.dataset.columnId;
      const { beforeId, afterId } = getNeighborsFromDom(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      try {
        const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
      } catch (error) {
        setStatus(`Move rejected: ${error.message}`, true);
        await loadBoard();
      }
    });
  });
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];
  return draggableElements.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function getNeighborsFromDom(list, cardId) {
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
    await loadBoard();
    await refreshLabels();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

async function refreshLabels() {
  try {
    const res = await fetch(`${API_BASE}/api/labels`);
    if (res.ok) allLabels = await res.json();
  } catch {}
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  try {
    await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
  } catch (error) {
    setStatus(`Move failed: ${error.message}`, true);
  }
}

function getDropPosition(list, cardId) {
  const ids = [...list.querySelectorAll('.card')].map((el) => el.dataset.cardId);
  const index = ids.indexOf(cardId);
  return {
    afterId: index > 0 ? ids[index - 1] : null,
    beforeId: index >= 0 && index < ids.length - 1 ? ids[index + 1] : null,
  };
}

async function showAssignLabelMenu(cardId, anchor) {
  // simple prompt based assign for minimal change; in real would be dropdown
  const currentCard = findCard(cardId)?.card;
  const currentLabels = currentCard ? (currentCard.labels || []) : [];
  const labelOptions = allLabels.map(l => {
    const assigned = currentLabels.some(cl => cl.id === l.id);
    return `${assigned ? '✓ ' : ''}${l.name} (${l.id.slice(0,4)})`;
  }).join('\n');
  const choice = prompt(`Assign/unassign labels for card. Enter label name or id to toggle:\n${labelOptions || 'No labels'}`);
  if (!choice) return;
  const match = allLabels.find(l => l.name.toLowerCase() === choice.toLowerCase().trim() || l.id === choice.trim());
  if (!match) { alert('Label not found'); return; }
  const isAssigned = currentLabels.some(l => l.id === match.id);
  try {
    if (isAssigned) {
      await fetch(`${API_BASE}/api/cards/${cardId}/labels/${match.id}`, { method: 'DELETE' });
    } else {
      await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labelId: match.id }),
      });
    }
  } catch (e) { alert(e.message); }
}

start();
