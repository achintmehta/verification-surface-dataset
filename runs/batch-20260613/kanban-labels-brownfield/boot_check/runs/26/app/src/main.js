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

function render() {
  const filteredBoard = getFilteredBoard();
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="filter-bar">
      <label>Filter by labels:</label>
      <select class="filter-select" multiple size="3">
        ${labels.map(l => 
          `<option value="${escapeHtml(l.id)}" ${selectedLabelIds.has(l.id) ? 'selected' : ''}>${escapeHtml(l.name)}</option>`
        ).join('')}
      </select>
      <button type="button" id="clear-filter">Clear filter</button>
      <button type="button" id="manage-labels">Manage Labels</button>
    </div>
    <main class="board">
      ${filteredBoard.columns.map(renderColumn).join('')}
    </main>
    <div id="label-manager" class="label-manager" style="display:none;">
      <h3>Labels</h3>
      <form id="create-label-form" style="display:flex;gap:0.5rem;margin:0.5rem 0;">
        <input name="name" placeholder="Label name" required maxlength="50" />
        <input name="color" type="color" value="#3b82f6" />
        <button type="submit">Create</button>
      </form>
      <div class="label-list">
        ${labels.map(renderLabelItem).join('')}
      </div>
      <button type="button" id="close-label-manager">Close</button>
    </div>
  `;
  bindEvents();
}

function renderLabelItem(label) {
  return `
    <div class="label-item">
      <span class="label-chip" style="background:${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
      <input type="text" value="${escapeHtml(label.name)}" data-edit-label-id="${escapeHtml(label.id)}" style="width:100px;" />
      <input type="color" value="${escapeHtml(label.color)}" data-edit-color-id="${escapeHtml(label.id)}" />
      <button type="button" data-update-label-id="${escapeHtml(label.id)}">Save</button>
      <button type="button" data-delete-label-id="${escapeHtml(label.id)}">Delete</button>
    </div>
  `;
}

function getFilteredBoard() {
  if (selectedLabelIds.size === 0) return board;
  return {
    columns: board.columns.map(col => ({
      ...col,
      cards: col.cards.filter(card => 
        (card.labels || []).some(l => selectedLabelIds.has(l.id))
      )
    }))
  };
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
    `<span class="label-chip" style="background:${escapeHtml(l.color)}" title="${escapeHtml(l.name)}">${escapeHtml(l.name)}</span>`
  ).join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div>${escapeHtml(card.text)}</div>
      <div class="label-chips">${chips}</div>
      <div class="card-label-actions">
        <select class="assign-label" data-card-id="${escapeHtml(card.id)}">
          <option value="">+ Label</option>
          ${labels.filter(l => !(card.labels || []).some(cl => cl.id === l.id)).map(l => 
            `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`
          ).join('')}
        </select>
        ${(card.labels || []).map(l => 
          `<button type="button" class="remove-label" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(l.id)}" style="background:${escapeHtml(l.color)}">×</button>`
        ).join('')}
      </div>
    </article>
  `;
}

function bindEvents() {
  // filter
  const filterSelect = document.querySelector('.filter-select');
  if (filterSelect) {
    filterSelect.addEventListener('change', () => {
      selectedLabelIds = new Set(Array.from(filterSelect.selectedOptions).map(o => o.value));
      render();
    });
  }
  const clearBtn = document.getElementById('clear-filter');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      selectedLabelIds.clear();
      render();
    });
  }
  const manageBtn = document.getElementById('manage-labels');
  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      const mgr = document.getElementById('label-manager');
      if (mgr) mgr.style.display = mgr.style.display === 'none' ? 'block' : 'none';
    });
  }
  const closeMgr = document.getElementById('close-label-manager');
  if (closeMgr) {
    closeMgr.addEventListener('click', () => {
      const mgr = document.getElementById('label-manager');
      if (mgr) mgr.style.display = 'none';
    });
  }
  // create label
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
          body: JSON.stringify({ name, color })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed');
        await loadLabels();
        render();
      } catch (err) {
        alert(err.message);
      }
    });
  }
  // label edit/delete
  document.querySelectorAll('[data-update-label-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.updateLabelId;
      const nameInput = document.querySelector(`[data-edit-label-id="${id}"]`);
      const colorInput = document.querySelector(`[data-edit-color-id="${id}"]`);
      if (!nameInput || !colorInput) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nameInput.value, color: colorInput.value })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed');
        await loadLabels();
        render();
      } catch (err) { alert(err.message); }
    });
  });
  document.querySelectorAll('[data-delete-label-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.deleteLabelId;
      if (!confirm('Delete label?')) return;
      try {
        await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
        await loadLabels();
        render();
      } catch (err) { alert(err.message); }
    });
  });
  // assign label
  document.querySelectorAll('.assign-label').forEach(sel => {
    sel.addEventListener('change', async () => {
      const cardId = sel.dataset.cardId;
      const labelId = sel.value;
      if (!labelId) return;
      try {
        await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labelId })
        });
        sel.value = '';
      } catch (err) {
        alert(err.message);
      }
    });
  });
  // remove label
  document.querySelectorAll('.remove-label').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cardId = btn.dataset.cardId;
      const labelId = btn.dataset.labelId;
      try {
        await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
      } catch (err) {
        alert(err.message);
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
    if (message.type && message.type.startsWith('label-')) {
      // refresh labels list too for manager
      loadLabels().then(() => render());
    } else {
      render();
    }
    setStatus('Synced');
    return;
  }

  if (message.type && message.type.startsWith('label-')) {
    // handle specific label updates if no full board
    render();
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

async function loadLabels() {
  const res = await fetch(`${API_BASE}/api/labels`);
  if (res.ok) labels = await res.json();
}

async function loadBoard() {
  const [boardRes, labelsRes] = await Promise.all([
    fetch(`${API_BASE}/api/board`),
    fetch(`${API_BASE}/api/labels`)
  ]);
  if (!boardRes.ok) throw new Error('Could not load board');
  if (!labelsRes.ok) throw new Error('Could not load labels');
  board = normalizeBoard(await boardRes.json());
  labels = await labelsRes.json();
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
