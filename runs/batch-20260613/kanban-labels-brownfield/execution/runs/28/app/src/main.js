import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let selectedLabelFilters = new Set();

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

function getFilteredBoard() {
  if (selectedLabelFilters.size === 0) return board;
  const filteredColumns = board.columns.map((column) => ({
    ...column,
    cards: column.cards.filter((card) => {
      const cardLabels = card.labels || [];
      return cardLabels.some((l) => selectedLabelFilters.has(l.id));
    }),
  }));
  return { columns: filteredColumns };
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
        <div id="status" class="status">Connecting…</div>
        <button id="manage-labels-btn" class="manage-btn">Manage Labels</button>
      </div>
    </header>
    <div class="filter-bar">
      <span class="filter-label">Filter by labels:</span>
      <div class="label-filters">
        ${labels.map((label) => `
          <label class="label-chip filter-chip ${selectedLabelFilters.has(label.id) ? 'selected' : ''}" style="--label-color: ${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}">
            <input type="checkbox" ${selectedLabelFilters.has(label.id) ? 'checked' : ''} />
            ${escapeHtml(label.name)}
          </label>
        `).join('')}
        ${labels.length === 0 ? '<span class="no-labels">No labels yet</span>' : ''}
      </div>
      <button id="clear-filters" class="clear-btn" ${selectedLabelFilters.size === 0 ? 'disabled' : ''}>Clear</button>
    </div>
    <main class="board">
      ${filteredBoard.columns.map(renderColumn).join('')}
    </main>
    <div id="label-manager" class="label-manager hidden">
      <div class="label-manager-content">
        <h3>Manage Labels</h3>
        <form id="create-label-form" class="create-label-form">
          <input name="name" type="text" placeholder="Label name" maxlength="50" required />
          <input name="color" type="color" value="#3b82f6" />
          <button type="submit">Create</button>
        </form>
        <div class="label-list">
          ${labels.map((label) => `
            <div class="label-item" data-label-id="${escapeHtml(label.id)}">
              <span class="label-chip" style="--label-color: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
              <input type="text" class="rename-input" value="${escapeHtml(label.name)}" />
              <input type="color" class="recolor-input" value="${escapeHtml(label.color)}" />
              <button class="save-label-btn">Save</button>
              <button class="delete-label-btn">Delete</button>
            </div>
          `).join('')}
          ${labels.length === 0 ? '<p>No labels created yet.</p>' : ''}
        </div>
        <button id="close-label-manager" class="close-btn">Close</button>
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
  const labelChips = (card.labels || []).map((label) => `
    <span class="label-chip small" style="--label-color: ${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}">${escapeHtml(label.name)}</span>
  `).join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-labels">${labelChips}</div>
      <div class="card-label-actions">
        <select class="assign-label-select" data-card-id="${escapeHtml(card.id)}">
          <option value="">+ Label</option>
          ${(labels || []).filter(l => !(card.labels || []).some(cl => cl.id === l.id)).map(l => `
            <option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>
          `).join('')}
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

  // drag and drop cards
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

  // label filter chips
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    const checkbox = chip.querySelector('input[type="checkbox"]');
    const labelId = chip.dataset.labelId;
    const toggle = () => {
      if (selectedLabelFilters.has(labelId)) {
        selectedLabelFilters.delete(labelId);
      } else {
        selectedLabelFilters.add(labelId);
      }
      render();
    };
    chip.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      checkbox.checked = !checkbox.checked;
      toggle();
    });
    checkbox.addEventListener('change', toggle);
  });

  document.getElementById('clear-filters')?.addEventListener('click', () => {
    selectedLabelFilters.clear();
    render();
  });

  // manage labels button
  document.getElementById('manage-labels-btn')?.addEventListener('click', () => {
    document.getElementById('label-manager').classList.remove('hidden');
  });
  document.getElementById('close-label-manager')?.addEventListener('click', () => {
    document.getElementById('label-manager').classList.add('hidden');
  });

  // create label form
  const createForm = document.getElementById('create-label-form');
  if (createForm) {
    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
      if (!name) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to create label');
        }
        createForm.reset();
        createForm.elements.color.value = '#3b82f6';
        await loadBoard(); // reloads labels too
      } catch (error) {
        setStatus(`Label create failed: ${error.message}`, true);
      }
    });
  }

  // label manager actions: save/delete
  document.querySelectorAll('.label-item').forEach((item) => {
    const labelId = item.dataset.labelId;
    const saveBtn = item.querySelector('.save-label-btn');
    const deleteBtn = item.querySelector('.delete-label-btn');
    const renameInput = item.querySelector('.rename-input');
    const recolorInput = item.querySelector('.recolor-input');

    saveBtn?.addEventListener('click', async () => {
      const name = renameInput.value.trim();
      const color = recolorInput.value;
      try {
        const res = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Update failed');
        }
        await loadBoard();
      } catch (error) {
        setStatus(`Label update failed: ${error.message}`, true);
      }
    });

    deleteBtn?.addEventListener('click', async () => {
      if (!confirm('Delete this label? It will be removed from all cards.')) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, {
          method: 'DELETE',
        });
        if (!res.ok) throw new Error('Delete failed');
        selectedLabelFilters.delete(labelId);
        await loadBoard();
      } catch (error) {
        setStatus(`Label delete failed: ${error.message}`, true);
      }
    });
  });

  // assign label selects on cards
  document.querySelectorAll('.assign-label-select').forEach((select) => {
    select.addEventListener('change', async () => {
      const labelId = select.value;
      const cardId = select.dataset.cardId;
      if (!labelId) return;
      try {
        const res = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labelId }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Assign failed');
        select.value = '';
        await loadBoard();
      } catch (error) {
        setStatus(`Assign label failed: ${error.message}`, true);
        await loadBoard();
      }
    });
  });

  // allow removing label by clicking chip (optional simple)
  document.querySelectorAll('.card-labels .label-chip').forEach((chip) => {
    chip.addEventListener('click', async (e) => {
      e.stopPropagation();
      const labelId = chip.dataset.labelId;
      const cardEl = chip.closest('.card');
      const cardId = cardEl?.dataset.cardId;
      if (!cardId || !labelId) return;
      try {
        await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, {
          method: 'DELETE',
        });
        await loadBoard();
      } catch (error) {
        setStatus(`Remove label failed: ${error.message}`, true);
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
    if (message.labels) {
      labels = message.labels;
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.labels) {
    labels = message.labels;
  }

  if (!message.card) {
    render();
    return;
  }
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
