import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedLabelIds = new Set();
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
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  return { columns };
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function filterBoardByLabels() {
  if (selectedLabelIds.size === 0) return board;
  const filteredColumns = board.columns.map((column) => ({
    ...column,
    cards: column.cards.filter((card) => {
      const cardLabelIds = (card.labels || []).map((l) => l.id);
      return cardLabelIds.some((id) => selectedLabelIds.has(id));
    }),
  }));
  return { columns: filteredColumns };
}

function render() {
  const filteredBoard = filterBoardByLabels();
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <div id="label-filter" class="label-filter"></div>
        <button id="manage-labels" class="manage-btn">Manage Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    <main class="board">
      ${filteredBoard.columns.map(renderColumn).join('')}
    </main>
    <div id="label-modal" class="modal hidden"></div>
  `;
  renderLabelFilter();
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
  const chips = (card.labels || []).map((label) =>
    `<span class="label-chip" style="background:${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}">${escapeHtml(label.name)}</span>`
  ).join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-labels">${chips}</div>
      <div class="card-actions">
        <button class="assign-label-btn" data-card-id="${escapeHtml(card.id)}">Labels</button>
      </div>
    </article>
  `;
}

function renderLabelFilter() {
  const container = document.getElementById('label-filter');
  if (!container) return;
  container.innerHTML = `
    <span class="filter-label">Filter:</span>
    ${labels.map((label) => {
      const active = selectedLabelIds.has(label.id);
      return `<span class="label-chip filter-chip ${active ? 'active' : ''}" style="background:${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}">${escapeHtml(label.name)}</span>`;
    }).join('')}
    ${selectedLabelIds.size > 0 ? '<button class="clear-filter">Clear</button>' : ''}
  `;
}

function showLabelModal() {
  const modal = document.getElementById('label-modal');
  if (!modal) return;
  modal.innerHTML = `
    <div class="modal-content">
      <h3>Manage Labels</h3>
      <form id="create-label-form" class="label-form">
        <input name="name" placeholder="Label name" required />
        <input name="color" type="color" value="#3b82f6" />
        <button type="submit">Create</button>
      </form>
      <div class="label-list">
        ${labels.map((label) => `
          <div class="label-row" data-label-id="${escapeHtml(label.id)}">
            <span class="label-chip" style="background:${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
            <input class="edit-name" value="${escapeHtml(label.name)}" />
            <input class="edit-color" type="color" value="${escapeHtml(label.color)}" />
            <button class="save-label">Save</button>
            <button class="delete-label">Delete</button>
          </div>
        `).join('')}
      </div>
      <button class="close-modal">Close</button>
    </div>
  `;
  modal.classList.remove('hidden');
  bindModalEvents(modal);
}

function bindModalEvents(modal) {
  const form = modal.querySelector('#create-label-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = form.elements.name.value;
      const color = form.elements.color.value;
      try {
        await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        await loadLabels();
        showLabelModal(); // refresh
      } catch (err) {
        alert('Failed to create label');
      }
    });
  }
  modal.querySelectorAll('.save-label').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const row = e.target.closest('.label-row');
      const id = row.dataset.labelId;
      const name = row.querySelector('.edit-name').value;
      const color = row.querySelector('.edit-color').value;
      try {
        await fetch(`${API_BASE}/api/labels/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        await loadLabels();
        showLabelModal();
      } catch (err) { alert('Update failed'); }
    });
  });
  modal.querySelectorAll('.delete-label').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const row = e.target.closest('.label-row');
      const id = row.dataset.labelId;
      if (!confirm('Delete label?')) return;
      try {
        await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
        await loadLabels();
        showLabelModal();
      } catch (err) { alert('Delete failed'); }
    });
  });
  modal.querySelector('.close-modal').addEventListener('click', () => {
    modal.classList.add('hidden');
  });
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

  // Label filter clicks
  const filterContainer = document.getElementById('label-filter');
  if (filterContainer) {
    filterContainer.addEventListener('click', (e) => {
      if (e.target.classList.contains('filter-chip')) {
        const id = e.target.dataset.labelId;
        if (selectedLabelIds.has(id)) selectedLabelIds.delete(id);
        else selectedLabelIds.add(id);
        render();
      } else if (e.target.classList.contains('clear-filter')) {
        selectedLabelIds.clear();
        render();
      }
    });
  }

  // Manage labels button
  const manageBtn = document.getElementById('manage-labels');
  if (manageBtn) {
    manageBtn.addEventListener('click', () => showLabelModal());
  }

  // Assign label buttons on cards
  document.querySelectorAll('.assign-label-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      await showAssignModal(cardId);
    });
  });

  // Click chip to unassign perhaps, but for simplicity keep assign modal
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

async function loadLabels() {
  try {
    const res = await fetch(`${API_BASE}/api/labels`);
    if (res.ok) labels = await res.json();
  } catch (_) {}
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
  await loadLabels();
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

async function showAssignModal(cardId) {
  const modal = document.getElementById('label-modal');
  if (!modal) return;
  const cardInfo = findCard(cardId);
  const currentLabels = cardInfo ? (cardInfo.card.labels || []) : [];
  const currentIds = new Set(currentLabels.map(l => l.id));
  modal.innerHTML = `
    <div class="modal-content">
      <h3>Labels for card</h3>
      <div class="label-list">
        ${labels.map((label) => {
          const assigned = currentIds.has(label.id);
          return `
            <div class="label-row">
              <span class="label-chip" style="background:${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
              <button class="${assigned ? 'unassign-btn' : 'assign-btn'}" data-label-id="${escapeHtml(label.id)}">${assigned ? 'Remove' : 'Assign'}</button>
            </div>
          `;
        }).join('')}
      </div>
      <button class="close-modal">Close</button>
    </div>
  `;
  modal.classList.remove('hidden');
  modal.querySelectorAll('.assign-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const lid = btn.dataset.labelId;
      await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({labelId: lid})
      });
      modal.classList.add('hidden');
      await loadBoard();
    });
  });
  modal.querySelectorAll('.unassign-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const lid = btn.dataset.labelId;
      await fetch(`${API_BASE}/api/cards/${cardId}/labels/${lid}`, { method: 'DELETE' });
      modal.classList.add('hidden');
      await loadBoard();
    });
  });
  modal.querySelector('.close-modal').addEventListener('click', () => modal.classList.add('hidden'));
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
