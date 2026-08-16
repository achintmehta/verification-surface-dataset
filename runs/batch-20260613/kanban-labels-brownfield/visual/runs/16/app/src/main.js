import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedLabelIds = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let isLabelManagerOpen = false;
let editingLabelId = null;
let cardLabelMenuOpen = null; // cardId

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
      <div class="topbar-actions">
        <button id="manage-labels-btn" class="btn">Manage Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    <div class="filter-bar">
      <span>Filter by labels:</span>
      <div class="filter-labels">
        ${labels.map(label => `
          <label class="filter-label ${selectedLabelIds.has(label.id) ? 'selected' : ''}" style="--label-color: ${escapeHtml(label.color)}">
            <input type="checkbox" value="${escapeHtml(label.id)}" ${selectedLabelIds.has(label.id) ? 'checked' : ''} class="filter-checkbox" />
            ${escapeHtml(label.name)}
          </label>
        `).join('')}
        ${selectedLabelIds.size > 0 ? `<button id="clear-filters-btn" class="btn-small">Clear</button>` : ''}
      </div>
    </div>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${isLabelManagerOpen ? renderLabelManager() : ''}
  `;
  bindEvents();
}

function renderLabelManager() {
  return `
    <div class="modal-overlay" id="label-manager-overlay">
      <div class="modal">
        <div class="modal-header">
          <h2>Manage Labels</h2>
          <button id="close-label-manager" class="btn-close">&times;</button>
        </div>
        <div class="modal-body">
          <ul class="label-list">
            ${labels.map(label => `
              <li class="label-item">
                ${editingLabelId === label.id ? `
                  <form class="edit-label-form" data-label-id="${escapeHtml(label.id)}">
                    <input type="text" name="name" value="${escapeHtml(label.name)}" required />
                    <input type="color" name="color" value="${escapeHtml(label.color)}" required />
                    <button type="submit" class="btn-small">Save</button>
                    <button type="button" class="btn-small cancel-edit-label">Cancel</button>
                  </form>
                ` : `
                  <div class="label-display">
                    <span class="label-chip" style="background-color: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
                    <div class="label-actions">
                      <button class="btn-small edit-label-btn" data-label-id="${escapeHtml(label.id)}">Edit</button>
                      <button class="btn-small delete-label-btn" data-label-id="${escapeHtml(label.id)}">Delete</button>
                    </div>
                  </div>
                `}
              </li>
            `).join('')}
          </ul>
          <form id="create-label-form" class="create-label-form">
            <input type="text" name="name" placeholder="New label name" required />
            <input type="color" name="color" value="#3b82f6" required />
            <button type="submit" class="btn">Create Label</button>
          </form>
        </div>
      </div>
    </div>
  `;
}


function renderColumn(column) {
  const visibleCards = column.cards.filter(card => {
    if (selectedLabelIds.size === 0) return true;
    return (card.labels || []).some(l => selectedLabelIds.has(l.id));
  });

  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${visibleCards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const cardLabels = card.labels || [];
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        ${cardLabels.map(l => `<span class="label-chip" style="background-color: ${escapeHtml(l.color)}">${escapeHtml(l.name)}</span>`).join('')}
        <button class="btn-icon add-label-btn" data-card-id="${escapeHtml(card.id)}">+</button>
      </div>
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${cardLabelMenuOpen === card.id ? renderCardLabelMenu(card) : ''}
    </article>
  `;
}

function renderCardLabelMenu(card) {
  const cardLabelIds = new Set((card.labels || []).map(l => l.id));
  return `
    <div class="card-label-menu">
      <div class="card-label-menu-header">
        <span>Labels</span>
        <button class="btn-close close-card-label-menu">&times;</button>
      </div>
      <div class="card-label-menu-body">
        ${labels.map(label => `
          <label class="card-label-option">
            <input type="checkbox" class="toggle-card-label" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}" ${cardLabelIds.has(label.id) ? 'checked' : ''} />
            <span class="label-chip" style="background-color: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
          </label>
        `).join('')}
      </div>
    </div>
  `;
}


function bindEvents() {
  document.getElementById('manage-labels-btn')?.addEventListener('click', () => {
    isLabelManagerOpen = true;
    render();
  });

  document.getElementById('close-label-manager')?.addEventListener('click', () => {
    isLabelManagerOpen = false;
    editingLabelId = null;
    render();
  });

  document.getElementById('create-label-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return;
    try {
      const res = await fetch(`${API_BASE}/api/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      form.reset();
    } catch (err) {
      alert(err.message);
    }
  });

  document.querySelectorAll('.edit-label-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      editingLabelId = btn.dataset.labelId;
      render();
    });
  });

  document.querySelectorAll('.cancel-edit-label').forEach(btn => {
    btn.addEventListener('click', () => {
      editingLabelId = null;
      render();
    });
  });

  document.querySelectorAll('.edit-label-form').forEach(form => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const labelId = form.dataset.labelId;
      const name = form.elements.name.value.trim();
      const color = form.elements.color.value;
      if (!name) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!res.ok) throw new Error((await res.json()).error);
        editingLabelId = null;
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll('.delete-label-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      if (!confirm('Delete this label?')) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, {
          method: 'DELETE'
        });
        if (!res.ok) throw new Error((await res.json()).error);
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll('.filter-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedLabelIds.add(e.target.value);
      } else {
        selectedLabelIds.delete(e.target.value);
      }
      render();
    });
  });

  document.getElementById('clear-filters-btn')?.addEventListener('click', () => {
    selectedLabelIds.clear();
    render();
  });

  document.querySelectorAll('.add-label-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      cardLabelMenuOpen = btn.dataset.cardId;
      render();
    });
  });

  document.querySelectorAll('.close-card-label-menu').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      cardLabelMenuOpen = null;
      render();
    });
  });

  document.querySelectorAll('.toggle-card-label').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      const cardId = cb.dataset.cardId;
      const labelId = cb.dataset.labelId;
      const isChecked = e.target.checked;
      try {
        const res = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels${isChecked ? '' : `/${encodeURIComponent(labelId)}`}`, {
          method: isChecked ? 'POST' : 'DELETE',
          headers: isChecked ? { 'Content-Type': 'application/json' } : undefined,
          body: isChecked ? JSON.stringify({ labelId }) : undefined
        });
        if (!res.ok) throw new Error((await res.json()).error);
      } catch (err) {
        alert(err.message);
        e.target.checked = !isChecked; // revert
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
    }
    if (message.board) board = normalizeBoard(message.board);
    render();
    return;
  }
  if (message.type === 'delete_label') {
    labels = labels.filter(l => l.id !== message.labelId);
    selectedLabelIds.delete(message.labelId);
    if (message.board) board = normalizeBoard(message.board);
    render();
    return;
  }
  if (message.type === 'assign_label' || message.type === 'unassign_label') {
    if (message.board) board = normalizeBoard(message.board);
    render();
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
