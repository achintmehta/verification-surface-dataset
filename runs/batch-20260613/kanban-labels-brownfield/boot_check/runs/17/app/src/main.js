import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedLabels = new Set();
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
  const dialogWasOpen = document.getElementById('labels-dialog')?.hasAttribute('open');

  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="filters">
      <div class="filter-labels">
        <strong>Filter by labels:</strong>
        ${labels.map(label => `
          <label class="filter-label">
            <input type="checkbox" value="${escapeHtml(label.id)}" ${selectedLabels.has(label.id) ? 'checked' : ''}>
            <span class="chip" style="background-color: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
          </label>
        `).join('')}
        ${selectedLabels.size > 0 ? `<button id="clear-filters">Clear</button>` : ''}
      </div>
      <button id="manage-labels-btn">Manage Labels</button>
    </div>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    <dialog id="labels-dialog">
      <div class="dialog-content">
        <h2>Manage Labels</h2>
        <ul id="labels-list">
          ${labels.map(label => `
            <li>
              <form class="edit-label-form" data-id="${escapeHtml(label.id)}">
                <input type="color" name="color" value="${escapeHtml(label.color)}">
                <input type="text" name="name" value="${escapeHtml(label.name)}" required>
                <button type="submit">Save</button>
                <button type="button" class="delete-label-btn" data-id="${escapeHtml(label.id)}">Delete</button>
              </form>
            </li>
          `).join('')}
        </ul>
        <form id="create-label-form">
          <h3>Create New Label</h3>
          <input type="color" name="color" value="#2563eb">
          <input type="text" name="name" placeholder="Label name" required>
          <button type="submit">Create</button>
        </form>
        <button id="close-labels-dialog">Close</button>
      </div>
    </dialog>
  `;
  bindEvents();

  if (dialogWasOpen) {
    document.getElementById('labels-dialog').showModal();
  }
}

function renderColumn(column) {
  const filteredCards = column.cards.filter(card => {
    if (selectedLabels.size === 0) return true;
    return card.labels && card.labels.some(l => selectedLabels.has(l.id));
  });

  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${filteredCards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        ${(card.labels || []).map(label => `
          <span class="chip" style="background-color: ${escapeHtml(label.color)}">
            ${escapeHtml(label.name)}
            <button class="remove-label-btn" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}">&times;</button>
          </span>
        `).join('')}
        <div class="add-label-dropdown">
          <button class="add-label-btn">+</button>
          <div class="dropdown-content">
            ${labels.filter(l => !(card.labels || []).some(cl => cl.id === l.id)).map(label => `
              <button class="assign-label-btn" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}">
                <span class="chip" style="background-color: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
              </button>
            `).join('')}
          </div>
        </div>
      </div>
      <div class="card-text">${escapeHtml(card.text)}</div>
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
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    cardEl.addEventListener('dragend', () => {
      draggedCardId = null;
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      list.classList.add('drop-target');
      const afterElement = getDragAfterElement(list, event.clientY);
      const dragging = document.querySelector('.dragging');
      if (dragging) {
        if (afterElement == null) {
          list.appendChild(dragging);
        } else {
          list.insertBefore(dragging, afterElement);
        }
      }
    });
    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) {
        list.classList.remove('drop-target');
      }
    });
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = list.dataset.columnId;
      const { beforeId, afterId } = getDropPosition(list, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      try {
        const response = await fetch(`${API_BASE}/api/cards/${draggedCardId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
        if (!response.ok) throw new Error('Move failed');
      } catch (error) {
        setStatus('Move failed, reloading…', true);
        setTimeout(loadBoard, 1000);
      }
    });
  });

  // Label filtering
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

  const clearFiltersBtn = document.getElementById('clear-filters');
  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener('click', () => {
      selectedLabels.clear();
      render();
    });
  }

  // Label management dialog
  const manageLabelsBtn = document.getElementById('manage-labels-btn');
  const labelsDialog = document.getElementById('labels-dialog');
  const closeLabelsDialog = document.getElementById('close-labels-dialog');

  if (manageLabelsBtn && labelsDialog) {
    manageLabelsBtn.addEventListener('click', () => {
      labelsDialog.showModal();
    });
  }

  if (closeLabelsDialog && labelsDialog) {
    closeLabelsDialog.addEventListener('click', () => {
      labelsDialog.close();
    });
  }

  const createLabelForm = document.getElementById('create-label-form');
  if (createLabelForm) {
    createLabelForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = createLabelForm.elements.name.value.trim();
      const color = createLabelForm.elements.color.value;
      if (!name) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to create label');
        createLabelForm.reset();
      } catch (err) {
        alert(err.message);
      }
    });
  }

  document.querySelectorAll('.edit-label-form').forEach(form => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = form.dataset.id;
      const name = form.elements.name.value.trim();
      const color = form.elements.color.value;
      if (!name) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to update label');
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll('.delete-label-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!confirm('Are you sure you want to delete this label?')) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels/${id}`, {
          method: 'DELETE'
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to delete label');
      } catch (err) {
        alert(err.message);
      }
    });
  });

  // Card label assignment
  document.querySelectorAll('.assign-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      const labelId = btn.dataset.labelId;
      try {
        const res = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labelId })
        });
        if (!res.ok) throw new Error('Failed to assign label');
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll('.remove-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      const labelId = btn.dataset.labelId;
      try {
        const res = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
          method: 'DELETE'
        });
        if (!res.ok) throw new Error('Failed to remove label');
      } catch (err) {
        alert(err.message);
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
      if (offset < 0 && offset > closest.offset) {
        return { offset: offset, element: child };
      } else {
        return closest;
      }
    },
    { offset: Number.NEGATIVE_INFINITY }
  ).element;
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

function applyMutation(message) {
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
      for (const col of board.columns) {
        for (const card of col.cards) {
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
  if (message.type === 'delete_label') {
    labels = labels.filter(l => l.id !== message.labelId);
    selectedLabels.delete(message.labelId);
    // Remove from cards
    for (const col of board.columns) {
      for (const card of col.cards) {
        if (card.labels) {
          card.labels = card.labels.filter(l => l.id !== message.labelId);
        }
      }
    }
    render();
    return;
  }
  if (message.type === 'assign_label' || message.type === 'unassign_label') {
    if (message.card) {
      const found = findCard(message.card.id);
      if (found) {
        found.card.labels = message.card.labels;
        render();
      }
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

async function loadBoard() {
  const [boardRes, labelsRes] = await Promise.all([
    fetch(`${API_BASE}/api/board`),
    fetch(`${API_BASE}/api/labels`)
  ]);
  if (!boardRes.ok || !labelsRes.ok) throw new Error('Could not load board or labels');
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
