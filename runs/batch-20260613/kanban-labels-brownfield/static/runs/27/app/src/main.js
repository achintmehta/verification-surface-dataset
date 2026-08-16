import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedFilterLabels = new Set();
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
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  return { columns };
}

function filterCards(cards) {
  if (selectedFilterLabels.size === 0) return cards;
  return cards.filter((card) => {
    const cardLabels = card.labels || [];
    return cardLabels.some((l) => selectedFilterLabels.has(l.id));
  });
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function renderLabelList() {
  const container = document.getElementById('label-list');
  if (!container) return;
  container.innerHTML = labels.map((label) => `
    <div class="label-item" data-label-id="${escapeHtml(label.id)}">
      <input type="text" value="${escapeHtml(label.name)}" data-field="name" />
      <input type="color" value="${escapeHtml(label.color)}" data-field="color" />
      <div class="label-actions">
        <button data-action="save">Save</button>
        <button data-action="delete">Delete</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.label-item').forEach((item) => {
    const id = item.dataset.labelId;
    item.querySelector('[data-action="save"]').addEventListener('click', async () => {
      const name = item.querySelector('[data-field="name"]').value;
      const color = item.querySelector('[data-field="color"]').value;
      await updateLabel(id, name, color);
    });
    item.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      await deleteLabel(id);
    });
  });
}

function setupFilter() {
  const sel = document.getElementById('label-filter');
  if (!sel) return;
  sel.addEventListener('change', () => {
    selectedFilterLabels.clear();
    Array.from(sel.selectedOptions).forEach((opt) => selectedFilterLabels.add(opt.value));
    // re-render only board part? but simple: render()
    render();
  });
  const clear = document.getElementById('clear-filter');
  if (clear) {
    clear.addEventListener('click', () => {
      selectedFilterLabels.clear();
      sel.selectedIndex = -1;
      render();
    });
  }
}

function render() {
  const filteredBoard = {
    columns: board.columns.map((col) => ({
      ...col,
      cards: filterCards(col.cards || []),
    })),
  };
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <button class="open-label-manager" id="open-label-manager">Manage Labels</button>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="filter-bar">
      <label>Filter by labels:</label>
      <select id="label-filter" class="filter-select" multiple size="3">
        ${labels.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('')}
      </select>
      <button id="clear-filter">Clear</button>
    </div>
    <main class="board">
      ${filteredBoard.columns.map(renderColumn).join('')}
    </main>
    <div class="label-manager ${labelManagerOpen ? 'open' : ''}" id="label-manager">
      <h3>Labels</h3>
      <form id="create-label-form">
        <input name="name" type="text" placeholder="New label name" required />
        <input name="color" type="color" value="#3b82f6" />
        <button type="submit">Create</button>
      </form>
      <div class="label-list" id="label-list"></div>
      <button id="close-label-manager">Close</button>
    </div>
  `;
  bindEvents();
  renderLabelList();
  setupFilter();
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
    <span class="label-chip" style="background: ${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}">
      ${escapeHtml(label.name)}
      <span class="remove" data-action="remove-label" data-label-id="${escapeHtml(label.id)}">×</span>
    </span>
  `).join('');
  const availableLabels = labels.filter((l) => !(card.labels || []).some((cl) => cl.id === l.id));
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      ${escapeHtml(card.text)}
      <div class="label-chips">${chips}</div>
      <div class="card-label-actions">
        <select class="assign-label" data-card-id="${escapeHtml(card.id)}">
          <option value="">+ Label</option>
          ${availableLabels.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('')}
        </select>
      </div>
    </article>
  `;
}

function bindEvents() {
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      if (!input || !input.value.trim()) return;
      await createCard(form.dataset.columnId, input.value);
      input.value = '';
    });
  });

  document.querySelectorAll('.card').forEach((cardEl) => {
    const cardId = cardEl.dataset.cardId;

    cardEl.addEventListener('dragstart', (e) => {
      draggedCardId = cardId;
      cardEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    cardEl.addEventListener('dragend', () => {
      draggedCardId = null;
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.cards').forEach((c) => c.classList.remove('drop-target'));
    });

    cardEl.querySelectorAll('.remove[data-action="remove-label"]').forEach((rem) => {
      rem.addEventListener('click', async (e) => {
        e.stopImmediatePropagation();
        const labelId = rem.dataset.labelId;
        await unassignLabel(cardId, labelId);
      });
    });

    const assignSel = cardEl.querySelector('.assign-label');
    if (assignSel) {
      assignSel.addEventListener('change', async () => {
        if (assignSel.value) {
          await assignLabel(cardId, assignSel.value);
          assignSel.value = '';
        }
      });
    }
  });

  document.querySelectorAll('.cards').forEach((list) => {
    const columnId = list.dataset.columnId;

    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      list.classList.add('drop-target');
    });

    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));

    list.addEventListener('drop', async (e) => {
      e.preventDefault();
      list.classList.remove('drop-target');
      if (!draggedCardId) return;
      const { afterId, beforeId } = getDropPosition(list, draggedCardId);
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });

  const openBtn = document.getElementById('open-label-manager');
  if (openBtn) openBtn.onclick = () => { labelManagerOpen = true; render(); };

  const closeBtn = document.getElementById('close-label-manager');
  if (closeBtn) closeBtn.onclick = () => { labelManagerOpen = false; render(); };

  const createForm = document.getElementById('create-label-form');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = createForm.elements.name.value;
      const color = createForm.elements.color.value;
      await createLabel(name, color);
      createForm.reset();
    });
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

async function loadLabels() {
  try {
    const res = await fetch(`${API_BASE}/api/labels`);
    if (res.ok) labels = await res.json();
  } catch {}
}

async function createLabel(name, color) {
  try {
    const res = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed');
    await loadLabels();
    render();
  } catch (e) {
    setStatus(`Label create failed: ${e.message}`, true);
  }
}

async function updateLabel(id, name, color) {
  try {
    const res = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed');
    await loadLabels();
    render();
  } catch (e) {
    setStatus(`Label update failed: ${e.message}`, true);
  }
}

async function deleteLabel(id) {
  try {
    const res = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed');
    await loadLabels();
    render();
  } catch (e) {
    setStatus(`Label delete failed: ${e.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const res = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed');
  } catch (e) {
    setStatus(`Assign failed: ${e.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const res = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed');
  } catch (e) {
    setStatus(`Unassign failed: ${e.message}`, true);
  }
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
    // also refresh labels if needed, but board has cards with labels
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
