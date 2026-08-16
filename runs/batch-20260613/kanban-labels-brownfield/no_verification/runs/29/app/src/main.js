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

function cardMatchesFilter(card) {
  if (selectedLabelIds.size === 0) return true;
  const cardLabels = card.labels || [];
  return cardLabels.some((l) => selectedLabelIds.has(l.id));
}

function render() {
  const filteredColumns = board.columns.map((col) => ({
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
      <button id="manage-labels-btn" style="margin-left:auto;font-size:0.8rem;padding:0.3rem 0.6rem;border-radius:6px;border:1px solid #cbd5e1;background:white;cursor:pointer">Manage Labels</button>
    </div>
    <div id="label-manager" style="display:none"></div>
    <main class="board">
      ${filteredColumns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
  renderLabelManagerIfOpen();
}

function renderFilterChip(label) {
  const selected = selectedLabelIds.has(label.id);
  return `<span class="filter-chip${selected ? ' selected' : ''}" data-label-id="${escapeHtml(label.id)}" style="background:${escapeHtml(label.color)};color:white;">${escapeHtml(label.name)}</span>`;
}

function renderLabelManager() {
  const container = document.getElementById('label-manager');
  if (!container) return;
  container.innerHTML = `
    <div class="label-manager">
      <h3>Labels</h3>
      <div class="label-list">
        ${labels.length ? labels.map((label) => `
          <span class="label-chip" style="background:${escapeHtml(label.color)}">
            <span class="label-name">${escapeHtml(label.name)}</span>
            <span class="label-actions">
              <button data-edit-label="${escapeHtml(label.id)}">✎</button>
              <button data-delete-label="${escapeHtml(label.id)}">×</button>
            </span>
          </span>
        `).join('') : '<span style="color:#64748b">No labels defined</span>'}
      </div>
      <form id="create-label-form" class="create-label-form">
        <input type="text" name="name" placeholder="New label name" required maxlength="100" />
        <input type="color" name="color" value="#3b82f6" />
        <button type="submit">Create</button>
      </form>
    </div>
  `;
  container.style.display = 'block';
  bindLabelManagerEvents(container);
}

function hideLabelManager() {
  const container = document.getElementById('label-manager');
  if (container) container.style.display = 'none';
}

function renderLabelManagerIfOpen() {
  const container = document.getElementById('label-manager');
  if (container && container.style.display !== 'none') {
    renderLabelManager();
  }
}

function bindLabelManagerEvents(container) {
  container.querySelectorAll('[data-edit-label]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.editLabel;
      const label = labels.find((l) => l.id === id);
      if (!label) return;
      const newName = prompt('Rename label:', label.name);
      if (newName === null) return;
      const newColor = prompt('New color (hex):', label.color);
      if (newColor === null) return;
      try {
        await fetch(`${API_BASE}/api/labels/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName, color: newColor }),
        });
      } catch (e) {
        alert('Update failed');
      }
    });
  });
  container.querySelectorAll('[data-delete-label]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.deleteLabel;
      if (!confirm('Delete this label?')) return;
      try {
        await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
      } catch (e) {
        alert('Delete failed');
      }
    });
  });
  const form = container.querySelector('#create-label-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = form.elements.name.value;
      const color = form.elements.color.value;
      try {
        const res = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!res.ok) {
          const err = await res.json();
          alert(err.error || 'Create failed');
        }
        form.reset();
      } catch (err) {
        alert('Create failed');
      }
    });
  }
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
  const labelChips = (card.labels || []).map((l) => 
    `<span class="label-chip" style="background:${escapeHtml(l.color)}" data-label-id="${escapeHtml(l.id)}"><span class="label-name">${escapeHtml(l.name)}</span></span>`
  ).join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      ${escapeHtml(card.text)}
      <div class="card-labels">${labelChips}</div>
      <div class="add-label-select">
        <select data-add-label-for="${escapeHtml(card.id)}">
          <option value="">+ Add label</option>
          ${labels.filter((l) => !(card.labels || []).some((cl) => cl.id === l.id)).map((l) => 
            `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`
          ).join('')}
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
      const columnId = form.dataset.columnId;
      if (input.value.trim()) {
        await createCard(columnId, input.value);
        input.value = '';
      }
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
      cardEl.classList.remove('dragging');
      draggedCardId = null;
      document.querySelectorAll('.cards').forEach((c) => c.classList.remove('drop-target'));
    });
    cardEl.addEventListener('click', (e) => {
      if (e.target.closest('.label-chip') || e.target.closest('select')) return;
      // could open edit but not required
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

  // filter chips
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.labelId;
      if (selectedLabelIds.has(id)) {
        selectedLabelIds.delete(id);
      } else {
        selectedLabelIds.add(id);
      }
      render();
    });
  });

  // manage labels
  const manageBtn = document.getElementById('manage-labels-btn');
  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      const container = document.getElementById('label-manager');
      if (container.style.display === 'block') {
        hideLabelManager();
      } else {
        renderLabelManager();
      }
    });
  }

  // add label selects on cards
  document.querySelectorAll('select[data-add-label-for]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const cardId = sel.dataset.addLabelFor;
      const labelId = sel.value;
      if (labelId) {
        await assignLabel(cardId, labelId);
        sel.value = '';
      }
    });
  });

  // clicking label chip on card removes it
  document.querySelectorAll('.card-labels .label-chip').forEach((chip) => {
    chip.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardEl = chip.closest('.card');
      const cardId = cardEl.dataset.cardId;
      const labelId = chip.dataset.labelId;
      await unassignLabel(cardId, labelId);
    });
  });
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
  optimisticMove(cardId, columnId, beforeId, afterId);
  render();
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
    if (!response.ok) throw new Error('Move failed');
  } catch (error) {
    setStatus(`Move failed: ${error.message}`, true);
    await loadBoard();
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const res = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Assign failed');
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
  } catch (error) {
    setStatus('Unassign failed', true);
  }
}

async function loadLabels() {
  try {
    const res = await fetch(`${API_BASE}/api/labels`);
    if (res.ok) labels = await res.json();
  } catch {}
}

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
  await loadLabels();
  render();
}

function applyMutation(message) {
  if (message.board) {
    board = normalizeBoard(message.board);
    // also refresh labels? but board has no labels list, so reload labels on some events
    if (['label-create', 'label-update', 'label-delete'].includes(message.type)) {
      loadLabels().then(() => render());
    } else {
      render();
    }
    setStatus('Synced');
    return;
  }

  if (message.type && message.type.startsWith('label-')) {
    loadLabels().then(() => render());
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
