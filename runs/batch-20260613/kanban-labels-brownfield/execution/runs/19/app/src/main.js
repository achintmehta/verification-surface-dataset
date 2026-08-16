import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilters = new Set();
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
      <div id="status" class="status">Connecting…</div>
    </header>
    <section class="label-manager">
      <h3>Labels</h3>
      <div class="label-list">
        ${labels.map(renderLabelItem).join('')}
      </div>
      <form class="add-label-form">
        <input type="text" name="name" placeholder="New label name" required />
        <input type="color" name="color" value="#3b82f6" />
        <button type="submit">Add Label</button>
      </form>
    </section>
    <section class="filter-bar">
      <h3>Filter:</h3>
      <div class="filter-labels">
        ${labels.map(renderFilterLabel).join('')}
      </div>
      ${activeFilters.size > 0 ? '<button class="clear-filters">Clear</button>' : ''}
    </section>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderLabelItem(label) {
  return `
    <div class="label-item" data-label-id="${escapeHtml(label.id)}">
      <input type="color" class="edit-label-color" value="${escapeHtml(label.color)}" title="Change color" style="width:20px;height:20px;padding:0;border:none;cursor:pointer;" />
      <input type="text" class="edit-label-name" value="${escapeHtml(label.name)}" title="Rename" style="border:none;background:transparent;width:80px;font-size:0.8rem;" />
      <button class="delete-label" title="Delete">×</button>
    </div>
  `;
}

function renderFilterLabel(label) {
  const isActive = activeFilters.has(label.id);
  return `
    <span class="label-chip filter-label ${isActive ? 'active' : ''}" data-label-id="${escapeHtml(label.id)}" style="background-color: ${escapeHtml(label.color)}">
      ${escapeHtml(label.name)}
    </span>
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
        ${column.cards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  if (activeFilters.size > 0) {
    const cardLabelIds = new Set((card.labels || []).map(l => l.id));
    let hasMatch = false;
    for (const filterId of activeFilters) {
      if (cardLabelIds.has(filterId)) {
        hasMatch = true;
        break;
      }
    }
    if (!hasMatch) return '';
  }

  const unassignedLabels = labels.filter(l => !(card.labels || []).some(cl => cl.id === l.id));

  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        ${(card.labels || []).map(l => `<span class="label-chip" style="background-color: ${escapeHtml(l.color)}">${escapeHtml(l.name)} <button class="unassign-label" data-label-id="${escapeHtml(l.id)}" style="background:none;border:none;color:white;cursor:pointer;padding:0;margin-left:2px;">×</button></span>`).join('')}
      </div>
      ${escapeHtml(card.text)}
      <div class="card-label-assign">
        ${unassignedLabels.length > 0 ? `
          <select class="assign-label-select">
            <option value="">Add label...</option>
            ${unassignedLabels.map(l => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('')}
          </select>
          <button class="assign-label-btn">Add</button>
        ` : ''}
      </div>
    </article>
  `;
}


function bindEvents() {
  const addLabelForm = document.querySelector('.add-label-form');
  if (addLabelForm) {
    addLabelForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = addLabelForm.elements.name.value.trim();
      const color = addLabelForm.elements.color.value;
      if (!name) return;
      try {
        const response = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Failed to create label');
        addLabelForm.reset();
      } catch (error) {
        setStatus(`Error: ${error.message}`, true);
      }
    });
  }


  document.querySelectorAll('.edit-label-color').forEach(input => {
    input.addEventListener('change', async (e) => {
      const labelItem = e.target.closest('.label-item');
      const labelId = labelItem.dataset.labelId;
      const name = labelItem.querySelector('.edit-label-name').value.trim();
      const color = e.target.value;
      if (!name) return;
      try {
        const response = await fetch(`${API_BASE}/api/labels/${labelId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!response.ok) throw new Error('Failed to update label');
      } catch (error) {
        setStatus(`Error: ${error.message}`, true);
      }
    });
  });

  document.querySelectorAll('.edit-label-name').forEach(input => {
    input.addEventListener('change', async (e) => {
      const labelItem = e.target.closest('.label-item');
      const labelId = labelItem.dataset.labelId;
      const name = e.target.value.trim();
      const color = labelItem.querySelector('.edit-label-color').value;
      if (!name) return;
      try {
        const response = await fetch(`${API_BASE}/api/labels/${labelId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!response.ok) throw new Error('Failed to update label');
      } catch (error) {
        setStatus(`Error: ${error.message}`, true);
      }
    });
  });

  document.querySelectorAll('.delete-label').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const labelId = e.target.closest('.label-item').dataset.labelId;
      try {
        const response = await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Failed to delete label');
      } catch (error) {
        setStatus(`Error: ${error.message}`, true);
      }
    });
  });

  document.querySelectorAll('.filter-label').forEach(el => {
    el.addEventListener('click', () => {
      const labelId = el.dataset.labelId;
      if (activeFilters.has(labelId)) {
        activeFilters.delete(labelId);
      } else {
        activeFilters.add(labelId);
      }
      render();
    });
  });

  const clearFiltersBtn = document.querySelector('.clear-filters');
  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener('click', () => {
      activeFilters.clear();
      render();
    });
  }

  document.querySelectorAll('.assign-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const cardEl = e.target.closest('.card');
      const cardId = cardEl.dataset.cardId;
      const select = cardEl.querySelector('.assign-label-select');
      const labelId = select.value;
      if (!labelId) return;
      try {
        const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labelId }),
        });
        if (!response.ok) throw new Error('Failed to assign label');
      } catch (error) {
        setStatus(`Error: ${error.message}`, true);
      }
    });
  });

  document.querySelectorAll('.unassign-label').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const cardEl = e.target.closest('.card');
      const cardId = cardEl.dataset.cardId;
      const labelId = e.target.dataset.labelId;
      try {
        const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Failed to unassign label');
      } catch (error) {
        setStatus(`Error: ${error.message}`, true);
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
        await loadLabels();
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
  if (message.type === 'createLabel') {
    labels.push(message.label);
    labels.sort((a, b) => a.name.localeCompare(b.name));
    render();
    return;
  }
  if (message.type === 'updateLabel') {
    const index = labels.findIndex(l => l.id === message.label.id);
    if (index !== -1) {
      labels[index] = message.label;
      labels.sort((a, b) => a.name.localeCompare(b.name));
      // Update labels in cards
      for (const column of board.columns) {
        for (const card of column.cards) {
          if (card.labels) {
            const lIndex = card.labels.findIndex(l => l.id === message.label.id);
            if (lIndex !== -1) card.labels[lIndex] = message.label;
          }
        }
      }
      render();
    }
    return;
  }
  if (message.type === 'deleteLabel') {
    labels = labels.filter(l => l.id !== message.labelId);
    activeFilters.delete(message.labelId);
    // Remove from cards
    for (const column of board.columns) {
      for (const card of column.cards) {
        if (card.labels) {
          card.labels = card.labels.filter(l => l.id !== message.labelId);
        }
      }
    }
    render();
    return;
  }
  if (message.type === 'assignLabel' || message.type === 'unassignLabel') {
    const target = findCard(message.cardId);
    if (target) {
      target.card.labels = message.card.labels;
      render();
    }
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

async function loadLabels() {
  const response = await fetch(`${API_BASE}/api/labels`);
  if (!response.ok) throw new Error('Could not load labels');
  labels = await response.json();
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
    await loadLabels();
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
