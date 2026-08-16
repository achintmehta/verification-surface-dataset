import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let selectedLabelIds = new Set();

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

function filterVisibleCards() {
  if (selectedLabelIds.size === 0) {
    document.querySelectorAll('.card').forEach((c) => c.style.display = '');
    return;
  }
  document.querySelectorAll('.card').forEach((cardEl) => {
    const cardId = cardEl.dataset.cardId;
    const found = findCard(cardId);
    if (!found) return;
    const cardLabels = found.card.labels || [];
    const hasMatch = cardLabels.some((l) => selectedLabelIds.has(l.id));
    cardEl.style.display = hasMatch ? '' : 'none';
  });
}

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="label-controls">
      <div class="filter-bar">
        <span class="filter-label">Filter by labels:</span>
        <div class="label-filters">
          ${labels.map(renderLabelFilter).join('')}
        </div>
        <button class="clear-filter" ${selectedLabelIds.size === 0 ? 'disabled' : ''}>Clear</button>
      </div>
      <div class="label-manager">
        <details>
          <summary>Manage Labels</summary>
          <div class="label-manager-content">
            <form class="create-label">
              <input name="name" type="text" placeholder="New label name" maxlength="50" />
              <input name="color" type="color" value="#3b82f6" />
              <button type="submit">Create</button>
            </form>
            <div class="label-list">
              ${labels.map(renderLabelItem).join('')}
            </div>
          </div>
        </details>
      </div>
    </div>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
  filterVisibleCards();
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

function renderLabelFilter(label) {
  const checked = selectedLabelIds.has(label.id) ? 'checked' : '';
  return `
    <label class="label-filter">
      <input type="checkbox" value="${escapeHtml(label.id)}" ${checked} />
      <span class="label-chip" style="background:${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
    </label>
  `;
}

function renderLabelItem(label) {
  return `
    <div class="label-item" data-label-id="${escapeHtml(label.id)}">
      <span class="label-chip" style="background:${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
      <input type="text" class="label-name-edit" value="${escapeHtml(label.name)}" />
      <input type="color" class="label-color-edit" value="${escapeHtml(label.color)}" />
      <button class="save-label">Save</button>
      <button class="delete-label">Delete</button>
    </div>
  `;
}

function bindEvents() {
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const columnId = form.dataset.columnId;
      if (input && input.value.trim()) {
        await createCard(columnId, input.value.trim());
        input.value = '';
      }
    });
  });

  // drag and drop (preserving original behavior)
  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (e) => {
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.cards').forEach((c) => c.classList.remove('drop-target'));
      draggedCardId = null;
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      list.classList.add('drop-target');
    });
    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));
    list.addEventListener('drop', async (e) => {
      e.preventDefault();
      list.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = list.dataset.columnId;
      const { afterId, beforeId } = getDropPosition(list, draggedCardId);
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });

  // new label filter handlers
  document.querySelectorAll('.label-filter input').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedLabelIds.add(cb.value);
      else selectedLabelIds.delete(cb.value);
      filterVisibleCards();
    });
  });
  document.querySelector('.clear-filter')?.addEventListener('click', () => {
    selectedLabelIds.clear();
    render();
  });

  // create label
  document.querySelector('.create-label')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nameInput = e.target.elements.name;
    const colorInput = e.target.elements.color;
    const name = nameInput.value.trim();
    const color = colorInput.value;
    if (name) {
      await fetch(`${API_BASE}/api/labels`, {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name, color})
      }).catch(() => setStatus('Create label failed', true));
      nameInput.value = '';
    }
  });

  // assign label selects
  document.querySelectorAll('.assign-label').forEach((sel) => {
    sel.addEventListener('change', async () => {
      if (!sel.value) return;
      const cardId = sel.dataset.cardId;
      await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({labelId: sel.value})
      }).catch(() => setStatus('Assign failed', true));
      sel.value = '';
    });
  });

  // edit/delete labels
  document.querySelectorAll('.save-label').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      const item = ev.target.closest('.label-item');
      const id = item.dataset.labelId;
      const name = item.querySelector('.label-name-edit').value;
      const color = item.querySelector('.label-color-edit').value;
      await fetch(`${API_BASE}/api/labels/${id}`, {
        method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name, color})
      }).catch(() => setStatus('Save failed', true));
    });
  });
  document.querySelectorAll('.delete-label').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      const item = ev.target.closest('.label-item');
      const id = item.dataset.labelId;
      if (confirm('Delete label?')) {
        await fetch(`${API_BASE}/api/labels/${id}`, {method: 'DELETE'}).catch(() => setStatus('Delete failed', true));
      }
    });
  });

  // chip click to unassign from card
  document.querySelectorAll('.card .label-chip').forEach((chip) => {
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', async (ev) => {
      ev.stopImmediatePropagation();
      const cardEl = chip.closest('.card');
      const cardId = cardEl?.dataset.cardId;
      const labelId = chip.dataset.labelId;
      if (cardId && labelId) {
        await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' })
          .catch(() => setStatus('Unassign failed', true));
      }
    });
  });
}
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
  }
}

function getDropPosition(list, cardId) {
  const ids = [...list.querySelectorAll('.card')].map((el) => el.dataset.cardId).filter(id => id !== cardId);
  // simplistic, use current dom order
  const index = ids.length; // append by default? but better calc
  return {
    afterId: ids.length > 0 ? ids[ids.length-1] : null,
    beforeId: null
  };
}

function applyMutation(message) {
  if (message.board) {
    board = normalizeBoard(message.board);
    // labels may have changed too, reload them for consistency
    loadLabels().then(() => {
      render();
      filterVisibleCards();
    }).catch(() => render());
    setStatus('Synced');
    return;
  }

  if (message.type && message.type.startsWith('label-')) {
    // for label mutations, refresh board and labels
    loadBoard().catch(() => {});
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
  filterVisibleCards();
  setStatus('Synced');
}

async function loadBoard() {
  const [boardRes, labelsRes] = await Promise.all([
    fetch(`${API_BASE}/api/board`),
    fetch(`${API_BASE}/api/labels`)
  ]);
  if (!boardRes.ok) throw new Error('Could not load board');
  board = normalizeBoard(await boardRes.json());
  if (labelsRes.ok) labels = await labelsRes.json();
  else labels = [];
  render();
  filterVisibleCards();
}

async function loadLabels() {
  const res = await fetch(`${API_BASE}/api/labels`);
  if (res.ok) labels = await res.json();
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
