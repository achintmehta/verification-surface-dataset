import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedLabelFilters = new Set();
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

function getFilteredBoard() {
  if (selectedLabelFilters.size === 0) return board;
  const filterSet = selectedLabelFilters;
  const filteredColumns = board.columns.map((column) => ({
    ...column,
    cards: column.cards.filter((card) => {
      const cardLabelIds = (card.labels || []).map((l) => l.id);
      return cardLabelIds.some((id) => filterSet.has(id));
    }),
  }));
  return { columns: filteredColumns };
}

function renderLabelList() {
  if (!labels.length) return '<p>No labels defined.</p>';
  return labels.map((label) => `
    <div class="label-item" data-label-id="${escapeHtml(label.id)}">
      <span class="label-chip" style="background:${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
      <input type="text" class="label-name-edit" value="${escapeHtml(label.name)}" />
      <input type="color" class="label-color-edit" value="${escapeHtml(label.color)}" />
      <button type="button" class="save-label small-btn">Save</button>
      <button type="button" class="delete-label small-btn danger">Delete</button>
    </div>
  `).join('');
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

function render() {
  const filteredBoard = getFilteredBoard();
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <div id="label-filter" class="label-filter">
          <span class="filter-label">Filter:</span>
          <div class="filter-chips">
            ${labels.map(l => `
              <button type="button" class="filter-chip ${selectedLabelFilters.has(l.id) ? 'active' : ''}" data-label-id="${escapeHtml(l.id)}" style="--label-color: ${escapeHtml(l.color)}">
                ${escapeHtml(l.name)}
              </button>
            `).join('')}
            ${labels.length === 0 ? '<span class="no-labels">No labels yet</span>' : ''}
          </div>
          <button type="button" id="clear-filter" class="small-btn" ${selectedLabelFilters.size === 0 ? 'disabled' : ''}>Clear</button>
        </div>
        <button type="button" id="manage-labels" class="small-btn">Manage Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    <main class="board">
      ${filteredBoard.columns.map(renderColumn).join('')}
    </main>
    <div id="label-modal" class="modal hidden">
      <div class="modal-content">
        <h3>Manage Labels</h3>
        <form id="create-label-form" class="label-form">
          <input name="name" type="text" placeholder="Label name" maxlength="50" required />
          <input name="color" type="color" value="#3b82f6" />
          <button type="submit">Create</button>
        </form>
        <div id="label-list" class="label-list">
          ${renderLabelList()}
        </div>
        <button type="button" id="close-modal" class="small-btn">Close</button>
      </div>
    </div>
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
  const chips = (card.labels || []).map(l => 
    `<span class="label-chip" style="background:${escapeHtml(l.color)}" data-label-id="${escapeHtml(l.id)}">${escapeHtml(l.name)}</span>`
  ).join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-labels">${chips}</div>
      <div class="card-label-actions">
        <select class="assign-label" data-card-id="${escapeHtml(card.id)}">
          <option value="">+ Label</option>
          ${labels.filter(l => !(card.labels || []).some(cl => cl.id === l.id)).map(l => 
            `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`
          ).join('')}
        </select>
      </div>
    </article>
  `;
}

function bindEvents() {
  // Label filter chips
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.labelId;
      if (selectedLabelFilters.has(id)) {
        selectedLabelFilters.delete(id);
      } else {
        selectedLabelFilters.add(id);
      }
      render();
    });
  });
  const clearBtn = document.getElementById('clear-filter');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      selectedLabelFilters.clear();
      render();
    });
  }

  // Manage labels modal
  const manageBtn = document.getElementById('manage-labels');
  const modal = document.getElementById('label-modal');
  if (manageBtn && modal) {
    manageBtn.addEventListener('click', () => {
      modal.classList.remove('hidden');
      // re-render list inside
      const list = document.getElementById('label-list');
      if (list) list.innerHTML = renderLabelList();
      bindLabelManagerEvents(modal);
    });
  }
  const closeBtn = document.getElementById('close-modal');
  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  }

  // Create label form
  const createForm = document.getElementById('create-label-form');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = createForm.elements.name.value;
      const color = createForm.elements.color.value;
      try {
        const res = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed');
        await loadLabels();
        render();
        // refresh list if open
        const list = document.getElementById('label-list');
        if (list && !modal.classList.contains('hidden')) list.innerHTML = renderLabelList();
      } catch (err) {
        alert('Create label failed: ' + err.message);
      }
    });
  }

  // Card label assign selects
  document.querySelectorAll('.assign-label').forEach((select) => {
    select.addEventListener('change', async () => {
      const cardId = select.dataset.cardId;
      const labelId = select.value;
      if (!labelId) return;
      try {
        await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labelId }),
        });
        // server will broadcast update
        select.value = '';
      } catch (err) {
        alert('Assign failed: ' + err.message);
      }
    });
  });

  // Click chip to remove label from card
  document.querySelectorAll('.card-labels .label-chip').forEach((chip) => {
    chip.addEventListener('click', async (e) => {
      e.stopImmediatePropagation();
      const cardEl = chip.closest('.card');
      const cardId = cardEl?.dataset.cardId;
      const labelId = chip.dataset.labelId;
      if (cardId && labelId) {
        try {
          await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
        } catch (err) {
          alert('Remove label failed: ' + err.message);
        }
      }
    });
  });

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
    // also refresh labels list if changed
    if (message.type && message.type.startsWith('label-')) {
      // labels may have changed, reload them
      loadLabels().then(() => render()).catch(() => render());
      return;
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type && message.type.startsWith('label-')) {
    // for label ops without full board? but we send board, handled above
    loadBoard().then(() => loadLabels().then(render)).catch(() => {});
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
  labels = await response.json();
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

function bindLabelManagerEvents(modal) {
  const list = document.getElementById('label-list');
  if (!list) return;
  list.querySelectorAll('.save-label').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = btn.closest('.label-item');
      const id = item.dataset.labelId;
      const nameInput = item.querySelector('.label-name-edit');
      const colorInput = item.querySelector('.label-color-edit');
      try {
        const res = await fetch(`${API_BASE}/api/labels/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nameInput.value, color: colorInput.value }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Update failed');
        await loadLabels();
        render();
        if (modal && !modal.classList.contains('hidden')) {
          list.innerHTML = renderLabelList();
          bindLabelManagerEvents(modal);
        }
      } catch (err) {
        alert('Update failed: ' + err.message);
      }
    });
  });
  list.querySelectorAll('.delete-label').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = btn.closest('.label-item');
      const id = item.dataset.labelId;
      if (!confirm('Delete this label? It will be removed from all cards.')) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error || 'Delete failed');
        await loadLabels();
        selectedLabelFilters.delete(id);
        render();
        if (modal && !modal.classList.contains('hidden')) {
          list.innerHTML = renderLabelList();
          bindLabelManagerEvents(modal);
        }
      } catch (err) {
        alert('Delete failed: ' + err.message);
      }
    });
  });
}

async function start() {
  app.innerHTML = '<div class="loading">Loading board…</div>';
  try {
    await loadBoard();
    await loadLabels();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
