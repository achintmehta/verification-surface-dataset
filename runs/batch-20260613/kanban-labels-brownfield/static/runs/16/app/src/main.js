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

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="controls">
      <div class="filters">
        <strong>Filter by Label:</strong>
        ${labels.map(label => `
          <label class="filter-label">
            <input type="checkbox" value="${escapeHtml(label.id)}" ${selectedFilters.has(label.id) ? 'checked' : ''} class="filter-checkbox" />
            <span class="chip" style="background-color: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
          </label>
        `).join('')}
        ${selectedFilters.size > 0 ? \`<button id="clear-filters">Clear</button>\` : ''}
      </div>
      <div class="label-manager">
        <strong>Manage Labels:</strong>
        <form id="add-label-form">
          <input type="text" name="name" placeholder="Label name" required />
          <input type="color" name="color" value="#2563eb" required />
          <button type="submit">Add Label</button>
        </form>
        <div class="label-list">
          ${labels.map(label => `
            <div class="label-item">
              <form class="edit-label-form" data-label-id="${escapeHtml(label.id)}">
                <input type="text" name="name" value="${escapeHtml(label.name)}" required />
                <input type="color" name="color" value="${escapeHtml(label.color)}" required />
                <button type="submit">Save</button>
              </form>
              <button class="delete-label" data-label-id="${escapeHtml(label.id)}">Delete</button>
            </div>
          `).join('')}
        </div>
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
        ${column.cards.filter(cardMatchesFilter).map(renderCard).join('')}
      </div>
    </section>
  `;
}

function cardMatchesFilter(card) {
  if (selectedFilters.size === 0) return true;
  const cardLabelIds = (card.labels || []).map(l => l.id);
  for (const filterId of selectedFilters) {
    if (cardLabelIds.includes(filterId)) return true;
  }
  return false;
}

function renderCard(card) {
  const cardLabels = card.labels || [];
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        ${cardLabels.map(label => `
          <span class="chip" style="background-color: ${escapeHtml(label.color)}">
            ${escapeHtml(label.name)}
            <button class="remove-label" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}">&times;</button>
          </span>
        `).join('')}
      </div>
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="assign-label">
        <select class="assign-label-select" data-card-id="${escapeHtml(card.id)}">
          <option value="">Add label...</option>
          ${labels.filter(l => !cardLabels.some(cl => cl.id === l.id)).map(l => `
            <option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>
          `).join('')}
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
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      await createCard(form.dataset.columnId, text);
    });
  });

  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      if (event.target.tagName === 'BUTTON' || event.target.tagName === 'SELECT' || event.target.tagName === 'OPTION') {
        event.preventDefault();
        return;
      }
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

  // Label filters
  document.querySelectorAll('.filter-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedFilters.add(e.target.value);
      } else {
        selectedFilters.delete(e.target.value);
      }
      render();
    });
  });

  const clearFiltersBtn = document.getElementById('clear-filters');
  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener('click', () => {
      selectedFilters.clear();
      render();
    });
  }

  // Label management
  const addLabelForm = document.getElementById('add-label-form');
  if (addLabelForm) {
    addLabelForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = addLabelForm.elements.name.value.trim();
      const color = addLabelForm.elements.color.value;
      if (!name) return;
      try {
        const response = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Failed to add label');
      } catch (error) {
        setStatus(`Error: ${error.message}`, true);
      }
    });
  }

  document.querySelectorAll('.edit-label-form').forEach(form => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const labelId = form.dataset.labelId;
      const name = form.elements.name.value.trim();
      const color = form.elements.color.value;
      if (!name) return;
      try {
        const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Failed to update label');
      } catch (error) {
        setStatus(`Error: ${error.message}`, true);
      }
    });
  });

  document.querySelectorAll('.delete-label').forEach(btn => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      try {
        const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, {
          method: 'DELETE',
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Failed to delete label');
      } catch (error) {
        setStatus(`Error: ${error.message}`, true);
      }
    });
  });

  // Card label assignment
  document.querySelectorAll('.assign-label-select').forEach(select => {
    select.addEventListener('change', async (e) => {
      const labelId = e.target.value;
      if (!labelId) return;
      const cardId = select.dataset.cardId;
      try {
        const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labelId }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Failed to assign label');
      } catch (error) {
        setStatus(`Error: ${error.message}`, true);
      }
    });
  });

  document.querySelectorAll('.remove-label').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      const labelId = btn.dataset.labelId;
      try {
        const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, {
          method: 'DELETE',
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Failed to remove label');
      } catch (error) {
        setStatus(`Error: ${error.message}`, true);
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

  if (message.type === 'create_label') {
    labels.push(message.label);
    labels.sort((a, b) => a.name.localeCompare(b.name));
    render();
    return;
  }

  if (message.type === 'update_label') {
    const index = labels.findIndex(l => l.id === message.label.id);
    if (index !== -1) {
      labels[index] = message.label;
      labels.sort((a, b) => a.name.localeCompare(b.name));
      // Update labels in cards
      for (const column of board.columns) {
        for (const card of column.cards) {
          if (card.labels) {
            const lIndex = card.labels.findIndex(l => l.id === message.label.id);
            if (lIndex !== -1) {
              card.labels[lIndex] = message.label;
            }
          }
        }
      }
      render();
    }
    return;
  }

  if (message.type === 'delete_label') {
    labels = labels.filter(l => l.id !== message.labelId);
    selectedFilters.delete(message.labelId);
    // Remove label from cards
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

  if (message.type === 'assign_label' || message.type === 'unassign_label') {
    const cardInfo = findCard(message.cardId);
    if (cardInfo) {
      cardInfo.card.labels = message.card.labels;
      render();
    }
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
    app.innerHTML = \`<div class="loading error">\${escapeHtml(error.message)}</div>\`;
  }
}

start();
