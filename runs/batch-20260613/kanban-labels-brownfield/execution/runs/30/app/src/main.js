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

function renderFilterChip(label) {
  const active = selectedLabelFilters.has(label.id);
  return `<span class="filter-chip${active ? ' active' : ''}" data-label-id="${escapeHtml(label.id)}" style="background:${label.color}; color:white; border-color:${active ? '#1e40af' : 'transparent'};">${escapeHtml(label.name)}</span>`;
}

function renderLabelItem(label) {
  return `
    <div class="label-chip" style="background:${label.color};" data-label-id="${escapeHtml(label.id)}">
      <span>${escapeHtml(label.name)}</span>
      <span class="edit" style="cursor:pointer; margin-left:0.25rem; font-size:0.7rem;">✎</span>
      <span class="delete" style="cursor:pointer; margin-left:0.1rem; font-size:0.7rem;">×</span>
    </div>
  `;
}

function renderCardLabels(cardId, labelsOnCard) {
  if (!labelsOnCard || !labelsOnCard.length) return '';
  return `<div class="card-labels">${labelsOnCard.map(l => `<span class="label-chip" style="background:${l.color}; cursor:pointer;" data-card-id="${escapeHtml(cardId)}" data-label-id="${escapeHtml(l.id)}" title="Click to remove">${escapeHtml(l.name)}</span>`).join('')}</div>`;
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
    <div class="filter-bar">
      <span style="font-weight:600; color:#475569; font-size:0.85rem;">Filter by labels:</span>
      ${labels.length ? labels.map(renderFilterChip).join('') : '<span style="color:#94a3b8; font-size:0.8rem;">No labels yet</span>'}
      <button id="clear-filters" style="margin-left:0.5rem; font-size:0.75rem; padding:0.2rem 0.5rem; border-radius:6px; border:1px solid #cbd5e1; background:white; cursor:pointer;">Clear</button>
    </div>
    <div class="label-manager">
      <div style="display:flex; align-items:center; justify-content:space-between;">
        <strong style="font-size:0.95rem;">Labels</strong>
        <form id="create-label-form" style="display:flex; gap:0.4rem; align-items:center;">
          <input name="name" type="text" placeholder="New label name" maxlength="50" style="padding:0.35rem 0.5rem; border:1px solid #cbd5e1; border-radius:6px; font-size:0.8rem;" />
          <input name="color" type="color" value="#3b82f6" style="width:2rem; height:1.6rem; padding:0; border:none;" />
          <button type="submit" style="padding:0.35rem 0.7rem; font-size:0.75rem; border-radius:6px; background:#2563eb; color:white; border:none; cursor:pointer;">Create</button>
        </form>
      </div>
      <div class="label-list" id="label-list">
        ${labels.map(renderLabelItem).join('')}
      </div>
    </div>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
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
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      ${escapeHtml(card.text)}
      ${renderCardLabels(card.id, card.labels)}
      <div class="card-actions" style="margin-top:0.4rem; display:flex; gap:0.3rem; flex-wrap:wrap;">
        <select class="assign-label" data-card-id="${escapeHtml(card.id)}" style="font-size:0.65rem; padding:0.1rem; border-radius:4px; border:1px solid #cbd5e1;">
          <option value="">+ label</option>
          ${labels.map(l => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('')}
        </select>
      </div>
    </article>
  `;
}

function bindEvents() {
  // existing add card
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

  // label create
  const createForm = document.getElementById('create-label-form');
  if (createForm) {
    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
      if (!name) return;
      createForm.elements.name.value = '';
      try {
        await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
      } catch (e) {
        setStatus('Label create failed', true);
      }
    });
  }

  // filter chips
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.labelId;
      if (selectedLabelFilters.has(id)) selectedLabelFilters.delete(id);
      else selectedLabelFilters.add(id);
      filterAndRenderBoard();
    });
  });

  const clearBtn = document.getElementById('clear-filters');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      selectedLabelFilters.clear();
      filterAndRenderBoard();
    });
  }

  // label manager actions
  document.querySelectorAll('#label-list .label-chip').forEach((item) => {
    const id = item.dataset.labelId;
    item.querySelector('.edit')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newName = prompt('New name for label?');
      if (newName == null) return;
      const newColor = prompt('New color hex (#rrggbb)?', '#3b82f6');
      if (newColor == null) return;
      try {
        await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName, color: newColor }),
        });
      } catch (err) {
        setStatus('Update failed', true);
      }
    });
    item.querySelector('.delete')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this label?')) return;
      try {
        await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch (err) {
        setStatus('Delete failed', true);
      }
    });
  });

  // assign labels on cards
  document.querySelectorAll('.assign-label').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const cardId = sel.dataset.cardId;
      const labelId = sel.value;
      if (!labelId) return;
      sel.value = '';
      try {
        await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labelId }),
        });
      } catch (e) {
        setStatus('Assign failed', true);
      }
    });
  });

  // remove label chips on cards
  document.querySelectorAll('.card-labels .label-chip').forEach((chip) => {
    chip.addEventListener('click', async (ev) => {
      ev.stopImmediatePropagation();
      const cardId = chip.dataset.cardId;
      const labelId = chip.dataset.labelId;
      if (!cardId || !labelId) return;
      try {
        await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, {
          method: 'DELETE',
        });
      } catch (e) {
        setStatus('Remove label failed', true);
      }
    });
  });

  // card drag etc
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
    if (message.labels) labels = message.labels;
    filterAndRenderBoard();
    setStatus('Synced');
    return;
  }

  if (message.labels) {
    labels = message.labels;
  }

  if (message.type && message.type.startsWith('label-')) {
    // label change, reload board state
    loadBoard().then(() => filterAndRenderBoard());
    return;
  }

  if (!message.card) return;
  const card = message.card;
  removeCardEverywhere(card.id);
  const target = board.columns.find((column) => column.id === card.column_id || column.id === message.columnId);
  if (!target) return;
  target.cards.push(card);
  target.cards.sort(compareCards);
  filterAndRenderBoard();
  setStatus('Synced');
}

function filterAndRenderBoard() {
  if (selectedLabelFilters.size === 0) {
    render();
    bindEvents();
    return;
  }
  // create filtered view
  const filteredBoard = {
    columns: board.columns.map(col => ({
      ...col,
      cards: col.cards.filter(card => {
        const cardLabelIds = (card.labels || []).map(l => l.id);
        return cardLabelIds.some(id => selectedLabelFilters.has(id));
      })
    }))
  };
  const originalBoard = board;
  board = filteredBoard;
  render();
  board = originalBoard; // restore for state
  bindEvents();
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
