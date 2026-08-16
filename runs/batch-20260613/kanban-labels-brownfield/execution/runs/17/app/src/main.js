import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labels = [];
let selectedLabels = new Set();
let isLabelManagerOpen = false;

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
      <div class="filter-bar">
        <span>Filter by labels:</span>
        ${labels.map(label => `
          <label class="filter-label" style="--label-color: ${escapeHtml(label.color)}">
            <input type="checkbox" value="${escapeHtml(label.id)}" ${selectedLabels.has(label.id) ? 'checked' : ''}>
            ${escapeHtml(label.name)}
          </label>
        `).join('')}
        ${selectedLabels.size > 0 ? `<button class="clear-filters">Clear</button>` : ''}
      </div>
      <button class="toggle-label-manager">Manage Labels</button>
    </div>
    ${isLabelManagerOpen ? renderLabelManager() : ''}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderLabelManager() {
  return `
    <div class="label-manager">
      <h3>Manage Labels</h3>
      <form class="add-label">
        <input name="name" type="text" placeholder="Label name" required />
        <input name="color" type="color" value="#ff0000" required />
        <button type="submit">Add Label</button>
      </form>
      <ul class="label-list">
        ${labels.map(label => `
          <li data-label-id="${escapeHtml(label.id)}">
            <form class="edit-label">
              <input name="name" type="text" value="${escapeHtml(label.name)}" required />
              <input name="color" type="color" value="${escapeHtml(label.color)}" required />
              <button type="submit">Save</button>
              <button type="button" class="delete-label">Delete</button>
            </form>
          </li>
        `).join('')}
      </ul>
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
        ${column.cards.filter(card => {
          if (selectedLabels.size === 0) return true;
          return card.labels && card.labels.some(l => selectedLabels.has(l.id));
        }).map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const cardLabels = card.labels || [];
  const unassignedLabels = labels.filter(l => !cardLabels.some(cl => cl.id === l.id));
  
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        ${cardLabels.map(label => `
          <span class="card-label" style="--label-color: ${escapeHtml(label.color)}">
            ${escapeHtml(label.name)}
            <button class="remove-label" data-label-id="${escapeHtml(label.id)}">&times;</button>
          </span>
        `).join('')}
      </div>
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${unassignedLabels.length > 0 ? `
        <div class="assign-label-container">
          <select class="assign-label-select">
            <option value="">Add label...</option>
            ${unassignedLabels.map(l => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('')}
          </select>
        </div>
      ` : ''}
    </article>
  `;
}

function bindEvents() {
  const toggleBtn = document.querySelector('.toggle-label-manager');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      isLabelManagerOpen = !isLabelManagerOpen;
      render();
    });
  }

  document.querySelectorAll('.filter-label input').forEach(input => {
    input.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedLabels.add(e.target.value);
      } else {
        selectedLabels.delete(e.target.value);
      }
      render();
    });
  });

  const clearBtn = document.querySelector('.clear-filters');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      selectedLabels.clear();
      render();
    });
  }

  const addLabelForm = document.querySelector('.add-label');
  if (addLabelForm) {
    addLabelForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = addLabelForm.elements.name.value.trim();
      const color = addLabelForm.elements.color.value;
      if (name) {
        await createLabel(name, color);
        addLabelForm.reset();
      }
    });
  }

  document.querySelectorAll('.edit-label').forEach(form => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = form.closest('li').dataset.labelId;
      const name = form.elements.name.value.trim();
      const color = form.elements.color.value;
      if (name) {
        await updateLabel(id, name, color);
      }
    });

    const deleteBtn = form.querySelector('.delete-label');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        const id = form.closest('li').dataset.labelId;
        await deleteLabel(id);
      });
    }
  });

  document.querySelectorAll('.assign-label-select').forEach(select => {
    select.addEventListener('change', async (e) => {
      const labelId = e.target.value;
      if (labelId) {
        const cardId = select.closest('.card').dataset.cardId;
        await assignLabel(cardId, labelId);
      }
    });
  });

  document.querySelectorAll('.remove-label').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const labelId = btn.dataset.labelId;
      const cardId = btn.closest('.card').dataset.cardId;
      await unassignLabel(cardId, labelId);
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
    await loadLabels();
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

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create label failed');
  } catch (error) {
    setStatus(`Create label failed: ${error.message}`, true);
  }
}

async function updateLabel(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update label failed');
  } catch (error) {
    setStatus(`Update label failed: ${error.message}`, true);
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Delete label failed');
  } catch (error) {
    setStatus(`Delete label failed: ${error.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Assign label failed');
  } catch (error) {
    setStatus(`Assign label failed: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Unassign label failed');
  } catch (error) {
    setStatus(`Unassign label failed: ${error.message}`, true);
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
  if (message.type === 'createLabel') {
    labels.push(message.label);
    labels.sort((a, b) => a.name.localeCompare(b.name));
    render();
    setStatus('Synced');
    return;
  }
  if (message.type === 'updateLabel') {
    const index = labels.findIndex(l => l.id === message.label.id);
    if (index !== -1) {
      labels[index] = message.label;
      labels.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }
  if (message.type === 'deleteLabel') {
    labels = labels.filter(l => l.id !== message.labelId);
    selectedLabels.delete(message.labelId);
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }
  if (message.type === 'assignLabel' || message.type === 'unassignLabel') {
    if (message.board) {
      board = normalizeBoard(message.board);
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
