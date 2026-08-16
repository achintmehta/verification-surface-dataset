import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedFilters = new Set();
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

function cardMatchesFilter(card) {
  if (selectedFilters.size === 0) return true;
  if (!card.labels || card.labels.length === 0) return false;
  return card.labels.some((l) => selectedFilters.has(l.id));
}

function render() {
  const visibleColumns = board.columns.map((col) => ({
    ...col,
    cards: col.cards.filter(cardMatchesFilter),
  }));

  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="filter-bar">
      <span class="filter-label">Filter by labels:</span>
      <div class="filter-chips">
        ${labels.length ? labels.map(renderFilterChip).join('') : '<span style="color:#94a3b8;font-size:0.8rem">No labels yet</span>'}
      </div>
      <button id="manage-labels-btn" style="margin-left:auto;font-size:0.8rem;padding:0.3rem 0.7rem;border-radius:8px;border:1px solid #cbd5e1;background:white;cursor:pointer;">Manage Labels</button>
    </div>
    <div id="label-manager" style="display:none;"></div>
    <main class="board">
      ${visibleColumns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
  bindLabelEvents();
}

function renderFilterChip(label) {
  const selected = selectedFilters.has(label.id);
  return `<span class="filter-chip" data-label-id="${escapeHtml(label.id)}" style="background:${label.color};color:white;${selected ? 'box-shadow:0 0 0 2px #172033;' : ''}">${escapeHtml(label.name)}</span>`;
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
    `<span class="label-chip" style="background:${l.color}" data-label-id="${escapeHtml(l.id)}">${escapeHtml(l.name)}<span class="remove" data-action="remove" data-label-id="${escapeHtml(l.id)}">×</span></span>`
  ).join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      ${escapeHtml(card.text)}
      <div class="label-chips">${chips}</div>
      <button class="add-label-btn" data-card-id="${escapeHtml(card.id)}">+ label</button>
    </article>
  `;
}

function renderLabelManager() {
  const container = document.getElementById('label-manager');
  if (!container) return;
  container.innerHTML = `
    <div class="label-manager">
      <h3>Label Manager</h3>
      <div class="label-list">
        ${labels.map(label => `
          <div class="label-row" data-label-id="${escapeHtml(label.id)}">
            <input type="text" value="${escapeHtml(label.name)}" data-field="name" />
            <input type="color" value="${label.color}" data-field="color" />
            <div class="label-actions">
              <button data-action="save">Save</button>
              <button data-action="delete" class="danger">Delete</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="create-label">
        <input id="new-label-name" type="text" placeholder="New label name" />
        <input id="new-label-color" type="color" value="#3b82f6" />
        <button id="create-label-btn">Create</button>
        <button id="close-manager-btn" style="background:#64748b;color:white;border:none;border-radius:8px;padding:0.5rem 0.9rem;cursor:pointer;">Close</button>
      </div>
    </div>
  `;
  bindManagerEvents(container);
}

function bindManagerEvents(container) {
  container.querySelectorAll('.label-row').forEach(row => {
    const id = row.dataset.labelId;
    row.querySelector('[data-action="save"]').addEventListener('click', async () => {
      const nameInput = row.querySelector('[data-field="name"]');
      const colorInput = row.querySelector('[data-field="color"]');
      try {
        await updateLabel(id, nameInput.value, colorInput.value);
      } catch (e) {
        alert(e.message);
      }
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      if (!confirm('Delete this label?')) return;
      try {
        await deleteLabel(id);
      } catch (e) {
        alert(e.message);
      }
    });
  });
  const createBtn = container.querySelector('#create-label-btn');
  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      const name = container.querySelector('#new-label-name').value;
      const color = container.querySelector('#new-label-color').value;
      try {
        await createLabel(name, color);
        container.querySelector('#new-label-name').value = '';
      } catch (e) {
        alert(e.message);
      }
    });
  }
  const closeBtn = container.querySelector('#close-manager-btn');
  if (closeBtn) closeBtn.addEventListener('click', () => {
    container.style.display = 'none';
  });
}

function bindLabelEvents() {
  // filter chips
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.labelId;
      if (selectedFilters.has(id)) {
        selectedFilters.delete(id);
      } else {
        selectedFilters.add(id);
      }
      render();
    });
  });

  // manage button
  const manageBtn = document.getElementById('manage-labels-btn');
  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      const mgr = document.getElementById('label-manager');
      if (mgr.style.display === 'none' || !mgr.style.display) {
        mgr.style.display = 'block';
        renderLabelManager();
      } else {
        mgr.style.display = 'none';
      }
    });
  }

  // add label buttons on cards
  document.querySelectorAll('.add-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      await showLabelPicker(cardId, btn);
    });
  });

  // remove label from chip
  document.querySelectorAll('.label-chip .remove').forEach(rem => {
    rem.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardEl = rem.closest('.card');
      const cardId = cardEl.dataset.cardId;
      const labelId = rem.dataset.labelId;
      try {
        await unassignLabel(cardId, labelId);
      } catch (err) {
        setStatus(`Error: ${err.message}`, true);
      }
    });
  });
}

async function showLabelPicker(cardId, anchor) {
  // simple picker: list all labels not assigned
  const card = findCard(cardId)?.card;
  const assigned = new Set((card?.labels || []).map(l => l.id));
  const available = labels.filter(l => !assigned.has(l.id));

  if (available.length === 0) {
    alert('All labels assigned or no labels exist.');
    return;
  }

  const picker = document.createElement('div');
  picker.style.cssText = 'position:absolute;background:white;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.1);z-index:100;padding:0.25rem;';
  picker.innerHTML = available.map(l => 
    `<div class="label-option" data-label-id="${escapeHtml(l.id)}" style="padding:0.35rem 0.6rem;cursor:pointer;display:flex;align-items:center;gap:0.4rem;">
      <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${l.color}"></span>
      <span>${escapeHtml(l.name)}</span>
    </div>`
  ).join('');

  document.body.appendChild(picker);
  const rect = anchor.getBoundingClientRect();
  picker.style.top = `${rect.bottom + window.scrollY + 4}px`;
  picker.style.left = `${rect.left + window.scrollX}px`;

  const cleanup = () => picker.remove();

  picker.querySelectorAll('.label-option').forEach(opt => {
    opt.addEventListener('click', async () => {
      cleanup();
      try {
        await assignLabel(cardId, opt.dataset.labelId);
      } catch (e) {
        setStatus(e.message, true);
      }
    });
  });

  setTimeout(() => {
    document.addEventListener('click', function onDoc(ev) {
      if (!picker.contains(ev.target)) {
        cleanup();
        document.removeEventListener('click', onDoc);
      }
    }, { once: true });
  }, 0);
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

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
  await loadLabels();
  render();
}

async function loadLabels() {
  const response = await fetch(`${API_BASE}/api/labels`);
  if (response.ok) {
    labels = await response.json();
  } else {
    labels = [];
  }
}

async function createLabel(name, color) {
  const res = await fetch(`${API_BASE}/api/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to create label');
  }
  await loadLabels();
  render();
}

async function updateLabel(id, name, color) {
  const res = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to update label');
  }
  await loadLabels();
  render();
}

async function deleteLabel(id) {
  const res = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to delete label');
  }
  selectedFilters.delete(id);
  await loadLabels();
  render();
}

async function assignLabel(cardId, labelId) {
  const res = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labelId }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Assign failed');
  }
  await loadBoard();
}

async function unassignLabel(cardId, labelId) {
  const res = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Unassign failed');
  }
  await loadBoard();
}

function applyMutation(message) {
  if (message.board) {
    board = normalizeBoard(message.board);
    // labels are included in board cards now
    render();
    setStatus('Synced');
    return;
  }

  if (message.type && message.type.startsWith('label-')) {
    // refresh labels and board for label changes
    loadLabels().then(() => {
      loadBoard().catch(() => {});
    });
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
