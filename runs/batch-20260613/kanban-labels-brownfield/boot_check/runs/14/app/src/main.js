import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelManagerOpen = false;
let cardLabelMenuFor = null;

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
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="toolbar">
      <div class="filter-bar">
        <span class="filter-label">Filter:</span>
        ${
          labels.length === 0
            ? '<span class="filter-empty">No labels yet</span>'
            : labels
                .map(
                  (label) => `
            <button type="button" class="filter-chip ${activeFilter.has(label.id) ? 'active' : ''}"
                    data-filter-label="${escapeHtml(label.id)}"
                    style="--chip-color:${escapeHtml(label.color)}">
              <span class="chip-dot"></span>${escapeHtml(label.name)}
            </button>`
                )
                .join('')
        }
        ${activeFilter.size > 0 ? '<button type="button" class="filter-clear" id="clear-filter">Clear filter</button>' : ''}
      </div>
      <button type="button" class="manage-labels-btn" id="manage-labels">Manage labels</button>
    </div>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${renderLabelManager()}
    ${renderCardLabelMenu()}
  `;
  bindEvents();
}

function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  const cardLabelIds = (card.labels || []).map((l) => l.id);
  return cardLabelIds.some((id) => activeFilter.has(id));
}

function renderLabelManager() {
  if (!labelManagerOpen) return '';
  return `
    <div class="modal-overlay" data-overlay="label-manager">
      <div class="modal">
        <div class="modal-head">
          <h2>Manage labels</h2>
          <button type="button" class="modal-close" data-close-manager>&times;</button>
        </div>
        <form class="label-create" id="label-create-form">
          <input name="name" type="text" maxlength="60" placeholder="Label name" autocomplete="off" />
          <input name="color" type="color" value="#2563eb" />
          <button type="submit">Add label</button>
        </form>
        <ul class="label-list">
          ${
            labels.length === 0
              ? '<li class="label-list-empty">No labels yet.</li>'
              : labels
                  .map(
                    (label) => `
            <li class="label-row" data-label-id="${escapeHtml(label.id)}">
              <input type="color" class="label-row-color" value="${escapeHtml(label.color)}" data-recolor="${escapeHtml(label.id)}" />
              <input type="text" class="label-row-name" value="${escapeHtml(label.name)}" maxlength="60" data-rename="${escapeHtml(label.id)}" />
              <button type="button" class="label-row-delete" data-delete-label="${escapeHtml(label.id)}">Delete</button>
            </li>`
                  )
                  .join('')
          }
        </ul>
      </div>
    </div>
  `;
}

function renderCardLabelMenu() {
  if (!cardLabelMenuFor) return '';
  const found = findCard(cardLabelMenuFor);
  if (!found) return '';
  const card = found.card;
  const assigned = new Set((card.labels || []).map((l) => l.id));
  return `
    <div class="modal-overlay" data-overlay="card-labels">
      <div class="modal">
        <div class="modal-head">
          <h2>Card labels</h2>
          <button type="button" class="modal-close" data-close-card-menu>&times;</button>
        </div>
        <ul class="label-pick-list">
          ${
            labels.length === 0
              ? '<li class="label-list-empty">No labels yet. Create some via “Manage labels”.</li>'
              : labels
                  .map(
                    (label) => `
            <li class="label-pick-row">
              <label>
                <input type="checkbox" data-toggle-card-label="${escapeHtml(label.id)}" ${assigned.has(label.id) ? 'checked' : ''} />
                <span class="chip" style="--chip-color:${escapeHtml(label.color)}"><span class="chip-dot"></span>${escapeHtml(label.name)}</span>
              </label>
            </li>`
                  )
                  .join('')
          }
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
        ${column.cards.filter(cardMatchesFilter).map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const chips = (card.labels || [])
    .map(
      (label) => `<span class="chip" style="--chip-color:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}"><span class="chip-dot"></span>${escapeHtml(label.name)}</span>`
    )
    .join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${chips ? `<div class="card-chips">${chips}</div>` : ''}
      <div class="card-actions">
        <button type="button" class="card-label-btn" data-card-label-btn="${escapeHtml(card.id)}">＋ labels</button>
      </div>
    </article>
  `;
}

function bindEvents() {
  bindLabelEvents();
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

function bindLabelEvents() {
  const manageBtn = document.querySelector('#manage-labels');
  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      labelManagerOpen = true;
      render();
    });
  }

  document.querySelectorAll('[data-filter-label]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.filterLabel;
      if (activeFilter.has(id)) activeFilter.delete(id);
      else activeFilter.add(id);
      render();
    });
  });

  const clearBtn = document.querySelector('#clear-filter');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilter.clear();
      render();
    });
  }

  // Card label buttons
  document.querySelectorAll('[data-card-label-btn]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      cardLabelMenuFor = btn.dataset.cardLabelBtn;
      render();
    });
  });
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('mousedown', (event) => event.stopPropagation());
    btn.draggable = false;
  });

  // Overlays / close
  document.querySelectorAll('[data-overlay]').forEach((overlay) => {
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        labelManagerOpen = false;
        cardLabelMenuFor = null;
        render();
      }
    });
  });
  const closeManager = document.querySelector('[data-close-manager]');
  if (closeManager) {
    closeManager.addEventListener('click', () => {
      labelManagerOpen = false;
      render();
    });
  }
  const closeCardMenu = document.querySelector('[data-close-card-menu]');
  if (closeCardMenu) {
    closeCardMenu.addEventListener('click', () => {
      cardLabelMenuFor = null;
      render();
    });
  }

  // Label manager create
  const createForm = document.querySelector('#label-create-form');
  if (createForm) {
    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
      if (!name) {
        setStatus('Label name is required', true);
        return;
      }
      await createLabel(name, color);
      createForm.reset();
      createForm.elements.color.value = color;
    });
  }

  // Rename
  document.querySelectorAll('[data-rename]').forEach((input) => {
    const commit = async () => {
      const id = input.dataset.rename;
      const label = labels.find((l) => l.id === id);
      const value = input.value.trim();
      if (!label || value === label.name) return;
      if (!value) {
        input.value = label.name;
        setStatus('Label name is required', true);
        return;
      }
      await updateLabel(id, { name: value });
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
    });
  });

  // Recolor
  document.querySelectorAll('[data-recolor]').forEach((input) => {
    input.addEventListener('change', async () => {
      const id = input.dataset.recolor;
      await updateLabel(id, { color: input.value });
    });
  });

  // Delete
  document.querySelectorAll('[data-delete-label]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteLabel(btn.dataset.deleteLabel);
    });
  });

  // Toggle card label assignment
  document.querySelectorAll('[data-toggle-card-label]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const labelId = checkbox.dataset.toggleCardLabel;
      const cardId = cardLabelMenuFor;
      if (!cardId) return;
      if (checkbox.checked) await assignLabel(cardId, labelId);
      else await unassignLabel(cardId, labelId);
    });
  });
}

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
  } catch (error) {
    setStatus(`Label create failed: ${error.message}`, true);
  }
}

async function updateLabel(id, patch) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update failed');
  } catch (error) {
    setStatus(`Label update failed: ${error.message}`, true);
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Delete failed');
    activeFilter.delete(id);
  } catch (error) {
    setStatus(`Label delete failed: ${error.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Assign failed');
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(
      `${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`,
      { method: 'DELETE' }
    );
    if (!response.ok) throw new Error((await response.json()).error || 'Unassign failed');
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
  }
}

async function loadLabels() {
  const response = await fetch(`${API_BASE}/api/labels`);
  if (!response.ok) throw new Error('Could not load labels');
  labels = await response.json();
}

function applyMutation(message) {
  if (message.type && message.type.startsWith('label-')) {
    if (Array.isArray(message.labels)) labels = message.labels;
    if (message.type === 'label-delete' && message.labelId) {
      activeFilter.delete(message.labelId);
    }
    if (message.board) {
      board = normalizeBoard(message.board);
      render();
      setStatus('Synced');
      return;
    }
    if (message.card) {
      removeCardEverywhere(message.card.id);
      const target = board.columns.find((column) => column.id === message.card.column_id || column.id === message.columnId);
      if (target) {
        target.cards.push(message.card);
        target.cards.sort(compareCards);
      }
    }
    render();
    setStatus('Synced');
    return;
  }

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
    await Promise.all([loadBoard(), loadLabels()]);
    render();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
