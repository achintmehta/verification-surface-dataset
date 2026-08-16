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
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="label-controls">
        <button id="manage-labels">Manage Labels</button>
        <div class="filter">
          <span>Filter:</span>
          <div id="label-filter" class="label-filter"></div>
          <button id="clear-filter" ${selectedLabelIds.size === 0 ? 'disabled' : ''}>Clear</button>
        </div>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
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
  const chips = (card.labels || []).map(label => 
    `<span class="label-chip" style="background:${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}">${escapeHtml(label.name)}</span>`
  ).join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-labels">${chips}</div>
      <div class="card-actions">
        <button class="assign-label" data-card-id="${escapeHtml(card.id)}">Labels</button>
      </div>
    </article>
  `;
}

function renderLabelChip(label, selected = false) {
  return `<span class="label-chip${selected ? ' selected' : ''}" style="background:${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`;
}

function renderLabelFilter() {
  const container = document.getElementById('label-filter');
  if (!container) return;
  container.innerHTML = labels.map(label => 
    `<span class="label-chip filter-chip${selectedLabelIds.has(label.id) ? ' selected' : ''}" style="background:${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}">${escapeHtml(label.name)}</span>`
  ).join('');
  container.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.labelId;
      if (selectedLabelIds.has(id)) selectedLabelIds.delete(id);
      else selectedLabelIds.add(id);
      filterAndRender();
    });
  });
}

function filterAndRender() {
  // Re-render board with filter applied client-side
  const filteredBoard = {
    columns: board.columns.map(col => ({
      ...col,
      cards: col.cards.filter(card => {
        if (selectedLabelIds.size === 0) return true;
        const cardLabelIds = (card.labels || []).map(l => l.id);
        return cardLabelIds.some(id => selectedLabelIds.has(id));
      })
    }))
  };
  const originalBoard = board;
  board = filteredBoard;
  const main = document.querySelector('.board');
  if (main) {
    main.innerHTML = board.columns.map(renderColumn).join('');
    bindCardEvents();
  }
  board = originalBoard;
  renderLabelFilter();
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

  if (message.type && message.type.startsWith('label')) {
    // For label mutations, reload board and labels to converge
    loadBoard().then(() => loadLabels().then(() => {
      render();
      setStatus('Synced');
    }));
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

async function start() {
  app.innerHTML = '<div class="loading">Loading board…</div>';
  try {
    await loadBoard();
    await loadLabels();
    render();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

function showLabelManager() {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content">
      <h2>Manage Labels</h2>
      <form id="create-label-form" style="display:flex;gap:0.5rem;margin-bottom:1rem">
        <input name="name" placeholder="Label name" required style="flex:1" />
        <input name="color" type="color" value="#3b82f6" />
        <button type="submit">Create</button>
      </form>
      <div class="label-list" id="label-list"></div>
      <button id="close-modal">Close</button>
    </div>
  `;
  document.body.appendChild(modal);

  function renderList() {
    const listEl = modal.querySelector('#label-list');
    listEl.innerHTML = labels.map(label => `
      <div class="label-item" data-id="${escapeHtml(label.id)}">
        <span class="label-chip" style="background:${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
        <input type="text" value="${escapeHtml(label.name)}" class="edit-name" />
        <input type="color" value="${escapeHtml(label.color)}" class="edit-color" />
        <button class="save-edit">Save</button>
        <button class="delete-label">Delete</button>
      </div>
    `).join('');
    listEl.querySelectorAll('.save-edit').forEach((btn, i) => {
      btn.onclick = async () => {
        const item = btn.closest('.label-item');
        const id = item.dataset.id;
        const name = item.querySelector('.edit-name').value.trim();
        const color = item.querySelector('.edit-color').value;
        if (!name) return alert('Name required');
        try {
          const res = await fetch(`${API_BASE}/api/labels/${id}`, {
            method: 'PUT',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({name, color})
          });
          if (!res.ok) throw new Error((await res.json()).error);
          await loadLabels();
          renderList();
          render();
        } catch(e) { alert(e.message); }
      };
    });
    listEl.querySelectorAll('.delete-label').forEach(btn => {
      btn.onclick = async () => {
        const item = btn.closest('.label-item');
        const id = item.dataset.id;
        if (!confirm('Delete label?')) return;
        await fetch(`${API_BASE}/api/labels/${id}`, {method: 'DELETE'});
        await loadLabels();
        renderList();
        render();
      };
    });
  }

  renderList();

  modal.querySelector('#create-label-form').onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.name.value.trim();
    const color = form.color.value;
    if (!name) return;
    try {
      const res = await fetch(`${API_BASE}/api/labels`, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({name, color})
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await loadLabels();
      renderList();
      render();
      form.reset();
    } catch(e) { alert(e.message); }
  };

  modal.querySelector('#close-modal').onclick = () => {
    modal.remove();
    renderLabelFilter();
  };
}

function bindCardEvents() {
  // rebind assign buttons and drag after partial renders
  document.querySelectorAll('.assign-label').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopImmediatePropagation();
      const cardId = btn.dataset.cardId;
      const card = findCard(cardId)?.card;
      if (!card) return;
      const current = new Set((card.labels || []).map(l => l.id));
      const choice = prompt('Enter label ID to toggle (or list: ' + labels.map(l => l.id + ':' + l.name).join(', ') + '):');
      if (!choice) return;
      const label = labels.find(l => l.id === choice || l.name.toLowerCase() === choice.toLowerCase());
      if (!label) return alert('Label not found');
      const has = current.has(label.id);
      const method = has ? 'DELETE' : 'POST';
      const url = has ? `${API_BASE}/api/cards/${cardId}/labels/${label.id}` : `${API_BASE}/api/cards/${cardId}/labels`;
      const body = has ? undefined : JSON.stringify({labelId: label.id});
      await fetch(url, { method, headers: body ? {'Content-Type':'application/json'} : {}, body });
      // update will come via SSE
    };
  });
  // also make chips clickable to filter perhaps, but optional
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
    cardEl.addEventListener('dragstart', (event) => {
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.cards').forEach((c) => c.classList.remove('drop-target'));
      draggedCardId = null;
    });
  });

  document.querySelectorAll('.cards').forEach((columnEl) => {
    columnEl.addEventListener('dragover', (event) => {
      event.preventDefault();
      columnEl.classList.add('drop-target');
    });
    columnEl.addEventListener('dragleave', () => columnEl.classList.remove('drop-target'));
    columnEl.addEventListener('drop', async (event) => {
      event.preventDefault();
      columnEl.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = columnEl.dataset.columnId;
      const { afterId, beforeId } = getDropPosition(columnEl, event);
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });

  const manageBtn = document.getElementById('manage-labels');
  if (manageBtn) manageBtn.onclick = showLabelManager;

  const clearBtn = document.getElementById('clear-filter');
  if (clearBtn) clearBtn.onclick = () => {
    selectedLabelIds.clear();
    filterAndRender();
  };

  bindCardEvents();
}

bindEvents(); // ensure initial

start();
