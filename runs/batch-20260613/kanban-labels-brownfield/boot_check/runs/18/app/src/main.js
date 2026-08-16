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
  const isDialogOpen = document.getElementById('labels-dialog')?.open;

  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="toolbar" style="padding: 1rem; background: #f0f0f0; display: flex; gap: 1rem; align-items: center;">
      <div class="filter-bar" style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
        <strong>Filter:</strong>
        ${labels.map(l => `
          <label style="display: flex; align-items: center; gap: 0.25rem; cursor: pointer;">
            <input type="checkbox" class="filter-checkbox" value="${escapeHtml(l.id)}" ${selectedLabelIds.has(l.id) ? 'checked' : ''}>
            <span class="label-chip" style="background-color: ${escapeHtml(l.color)}; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8rem; color: #fff; text-shadow: 0 0 2px #000;">${escapeHtml(l.name)}</span>
          </label>
        `).join('')}
        ${selectedLabelIds.size > 0 ? `<button id="clear-filter" style="padding: 0.2rem 0.5rem;">Clear</button>` : ''}
      </div>
      <button id="manage-labels-btn" style="margin-left: auto; padding: 0.5rem 1rem;">Manage Labels</button>
    </div>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    <dialog id="labels-dialog" style="padding: 1rem; border-radius: 8px; border: 1px solid #ccc; max-width: 400px; width: 100%;">
      <form method="dialog">
        <h2 style="margin-top: 0;">Manage Labels</h2>
        <ul id="labels-list" style="list-style: none; padding: 0; margin: 1rem 0;">
          ${labels.map(l => `
            <li style="display: flex; gap: 0.5rem; margin-bottom: 0.5rem; align-items: center;">
              <input type="color" value="${escapeHtml(l.color)}" data-id="${escapeHtml(l.id)}" class="edit-label-color">
              <input type="text" value="${escapeHtml(l.name)}" data-id="${escapeHtml(l.id)}" class="edit-label-name" style="flex: 1;">
              <button type="button" data-id="${escapeHtml(l.id)}" class="delete-label-btn">Delete</button>
            </li>
          `).join('')}
        </ul>
        <h3 style="margin-bottom: 0.5rem;">Create Label</h3>
        <div class="create-label-form" style="display: flex; gap: 0.5rem; margin-bottom: 1rem;">
          <input type="color" id="new-label-color" value="#ff0000">
          <input type="text" id="new-label-name" placeholder="Label name" style="flex: 1;">
          <button type="button" id="create-label-btn">Create</button>
        </div>
        <div style="text-align: right;">
          <button type="submit">Close</button>
        </div>
      </form>
    </dialog>
  `;
  
  if (isDialogOpen) {
    document.getElementById('labels-dialog').showModal();
  }

  bindEvents();
}

function renderColumn(column) {
  const visibleCards = column.cards.filter(card => {
    if (selectedLabelIds.size === 0) return true;
    return card.labels && card.labels.some(l => selectedLabelIds.has(l.id));
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
  const unassignedLabels = labels.filter(l => !(card.labels || []).some(cl => cl.id === l.id));
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels" style="display: flex; flex-wrap: wrap; gap: 0.25rem; margin-bottom: 0.5rem;">
        ${(card.labels || []).map(l => `
          <span class="label-chip" style="background-color: ${escapeHtml(l.color)}; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.7rem; color: #fff; text-shadow: 0 0 2px #000; display: flex; align-items: center; gap: 0.25rem;" title="${escapeHtml(l.name)}">
            ${escapeHtml(l.name)}
            <button type="button" class="remove-label-btn" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(l.id)}" style="background: none; border: none; color: #fff; cursor: pointer; padding: 0; font-size: 1rem; line-height: 1;">&times;</button>
          </span>
        `).join('')}
      </div>
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${unassignedLabels.length > 0 ? `
        <select class="assign-label-select" data-card-id="${escapeHtml(card.id)}" style="margin-top: 0.5rem; width: 100%; font-size: 0.8rem; padding: 0.2rem;">
          <option value="">Add label...</option>
          ${unassignedLabels.map(l => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('')}
        </select>
      ` : ''}
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

  // Filter
  document.querySelectorAll('.filter-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      if (e.target.checked) selectedLabelIds.add(e.target.value);
      else selectedLabelIds.delete(e.target.value);
      render();
    });
  });

  const clearFilterBtn = document.getElementById('clear-filter');
  if (clearFilterBtn) {
    clearFilterBtn.addEventListener('click', () => {
      selectedLabelIds.clear();
      render();
    });
  }

  // Manage Labels Dialog
  const manageBtn = document.getElementById('manage-labels-btn');
  const dialog = document.getElementById('labels-dialog');
  if (manageBtn && dialog) {
    manageBtn.addEventListener('click', () => dialog.showModal());
  }

  // Create Label
  const createLabelBtn = document.getElementById('create-label-btn');
  if (createLabelBtn) {
    createLabelBtn.addEventListener('click', async () => {
      const name = document.getElementById('new-label-name').value.trim();
      const color = document.getElementById('new-label-color').value;
      if (!name) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!res.ok) throw new Error((await res.json()).error);
      } catch (e) {
        alert(e.message);
      }
    });
  }

  // Edit Label
  document.querySelectorAll('.edit-label-name, .edit-label-color').forEach(input => {
    input.addEventListener('change', async (e) => {
      const id = e.target.dataset.id;
      const li = e.target.closest('li');
      const name = li.querySelector('.edit-label-name').value.trim();
      const color = li.querySelector('.edit-label-color').value;
      if (!name) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!res.ok) throw new Error((await res.json()).error);
      } catch (err) {
        alert(err.message);
      }
    });
  });

  // Delete Label
  document.querySelectorAll('.delete-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.dataset.id;
      try {
        const res = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error);
      } catch (err) {
        alert(err.message);
      }
    });
  });

  // Assign Label
  document.querySelectorAll('.assign-label-select').forEach(select => {
    select.addEventListener('change', async (e) => {
      const labelId = e.target.value;
      if (!labelId) return;
      const cardId = e.target.dataset.cardId;
      try {
        const res = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labelId })
        });
        if (!res.ok) throw new Error((await res.json()).error);
      } catch (err) {
        alert(err.message);
      }
    });
  });

  // Unassign Label
  document.querySelectorAll('.remove-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const cardId = e.target.dataset.cardId;
      const labelId = e.target.dataset.labelId;
      try {
        const res = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error);
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
    if (index !== -1) labels[index] = message.label;
    for (const col of board.columns) {
      for (const card of col.cards) {
        if (card.labels) {
          const lIndex = card.labels.findIndex(l => l.id === message.label.id);
          if (lIndex !== -1) card.labels[lIndex] = message.label;
        }
      }
    }
    render();
    return;
  }
  if (message.type === 'delete_label') {
    labels = labels.filter(l => l.id !== message.labelId);
    selectedLabelIds.delete(message.labelId);
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
    const target = findCard(message.cardId);
    if (target && message.card) {
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
    await Promise.all([loadLabels(), loadBoard()]);
    render();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
