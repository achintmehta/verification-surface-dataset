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
  const dialog = document.querySelector('#label-manager-dialog');
  const wasOpen = dialog && dialog.open;
  const openDropdown = document.querySelector('.label-dropdown:not(.hidden)');
  const openDropdownCardId = openDropdown ? openDropdown.dataset.cardId : null;
  const newLabelNameInput = document.querySelector('#new-label-name');
  const newLabelName = newLabelNameInput ? newLabelNameInput.value : '';
  const newLabelColorInput = document.querySelector('#new-label-color');
  const newLabelColor = newLabelColorInput ? newLabelColorInput.value : '#ff0000';
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
        <strong>Filter:</strong>
        ${labels.map(label => `
          <label class="filter-label" style="--label-color: ${label.color}">
            <input type="checkbox" value="${label.id}" ${selectedLabelIds.has(label.id) ? 'checked' : ''} class="filter-checkbox" />
            ${escapeHtml(label.name)}
          </label>
        `).join('')}
        ${selectedLabelIds.size > 0 ? `<button class="clear-filter">Clear</button>` : ''}
      </div>
      <button class="manage-labels-btn">Manage Labels</button>
    </div>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    <dialog id="label-manager-dialog">
      <form method="dialog">
        <h2>Manage Labels</h2>
        <div class="label-list">
          ${labels.map(label => `
            <div class="label-item" data-label-id="${label.id}">
              <input type="color" value="${label.color}" class="edit-label-color" />
              <input type="text" value="${escapeHtml(label.name)}" class="edit-label-name" />
              <button type="button" class="save-label-btn">Save</button>
              <button type="button" class="delete-label-btn">Delete</button>
            </div>
          `).join('')}
        </div>
        <h3>Create New Label</h3>
        <div class="create-label">
          <input type="color" id="new-label-color" value="#ff0000" />
          <input type="text" id="new-label-name" placeholder="Label name" />
          <button type="button" id="create-label-btn">Create</button>
        </div>
        <button type="submit">Close</button>
      </form>
    </dialog>
  `;
  bindEvents();
  if (wasOpen) {
    const newDialog = document.querySelector('#label-manager-dialog');
    if (newDialog) newDialog.showModal();
  }
  if (openDropdownCardId) {
    const newDropdown = document.querySelector(`.label-dropdown[data-card-id="${openDropdownCardId}"]`);
    if (newDropdown) newDropdown.classList.remove('hidden');
  }
  const newNameInput = document.querySelector('#new-label-name');
  if (newNameInput && newLabelName) newNameInput.value = newLabelName;
  const newColorInput = document.querySelector('#new-label-color');
  if (newColorInput && newLabelColor) newColorInput.value = newLabelColor;
}

function renderColumn(column) {
  const filteredCards = column.cards.filter(card => {
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
        ${filteredCards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const cardLabels = card.labels || [];
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        ${cardLabels.map(l => `<span class="label-chip" style="background-color: ${l.color}" title="${escapeHtml(l.name)}"></span>`).join('')}
      </div>
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-actions">
        <button type="button" class="assign-label-btn" data-card-id="${escapeHtml(card.id)}">🏷️</button>
      </div>
      <div class="label-dropdown hidden" data-card-id="${escapeHtml(card.id)}">
        ${labels.map(label => {
          const hasLabel = cardLabels.some(l => l.id === label.id);
          return `
            <label>
              <input type="checkbox" class="card-label-checkbox" data-label-id="${label.id}" ${hasLabel ? 'checked' : ''} />
              <span class="label-chip" style="background-color: ${label.color}"></span>
              ${escapeHtml(label.name)}
            </label>
          `;
        }).join('')}
      </div>
    </article>
  `;
}

function bindEvents() {

  // Filter events
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

  const clearFilterBtn = document.querySelector('.clear-filter');
  if (clearFilterBtn) {
    clearFilterBtn.addEventListener('click', () => {
      selectedLabelIds.clear();
      render();
    });
  }

  // Manage labels dialog
  const manageLabelsBtn = document.querySelector('.manage-labels-btn');
  const dialog = document.querySelector('#label-manager-dialog');
  if (manageLabelsBtn && dialog) {
    manageLabelsBtn.addEventListener('click', () => {
      dialog.showModal();
    });
  }

  // Create label
  const createLabelBtn = document.querySelector('#create-label-btn');
  if (createLabelBtn) {
    createLabelBtn.addEventListener('click', async () => {
      const nameInput = document.querySelector('#new-label-name');
      const colorInput = document.querySelector('#new-label-color');
      const name = nameInput.value.trim();
      const color = colorInput.value;
      if (!name) return;
      try {
        const response = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Create label failed');
        nameInput.value = '';
      } catch (error) {
        alert(error.message);
      }
    });
  }

  // Edit label
  document.querySelectorAll('.save-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const item = e.target.closest('.label-item');
      const id = item.dataset.labelId;
      const name = item.querySelector('.edit-label-name').value.trim();
      const color = item.querySelector('.edit-label-color').value;
      if (!name) return;
      try {
        const response = await fetch(`${API_BASE}/api/labels/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Update label failed');
      } catch (error) {
        alert(error.message);
      }
    });
  });

  // Delete label
  document.querySelectorAll('.delete-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const item = e.target.closest('.label-item');
      const id = item.dataset.labelId;
      try {
        const response = await fetch(`${API_BASE}/api/labels/${id}`, {
          method: 'DELETE'
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Delete label failed');
      } catch (error) {
        alert(error.message);
      }
    });
  });

  // Assign label dropdown toggle
  document.querySelectorAll('.assign-label-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      const dropdown = document.querySelector(`.label-dropdown[data-card-id="${cardId}"]`);
      document.querySelectorAll('.label-dropdown').forEach(d => {
        if (d !== dropdown) d.classList.add('hidden');
      });
      dropdown.classList.toggle('hidden');
    });
  });

  // Close dropdowns when clicking outside
  // document click listener is handled outside

  // Assign/unassign label
  document.querySelectorAll('.card-label-checkbox').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      const cardId = e.target.closest('.label-dropdown').dataset.cardId;
      const labelId = e.target.dataset.labelId;
      const checked = e.target.checked;
      try {
        if (checked) {
          const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId })
          });
          if (!response.ok) throw new Error((await response.json()).error || 'Assign label failed');
        } else {
          const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
            method: 'DELETE'
          });
          if (!response.ok) throw new Error((await response.json()).error || 'Unassign label failed');
        }
      } catch (error) {
        alert(error.message);
        e.target.checked = !checked; // revert
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
      labels.sort((a, b) => a.name.localeCompare(b.name));
      render();
    }
    return;
  }
  if (message.type === 'delete_label') {
    labels = labels.filter(l => l.id !== message.labelId);
    selectedLabelIds.delete(message.labelId);
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
    const card = message.card;
    removeCardEverywhere(card.id);
    const target = board.columns.find((column) => column.id === card.column_id);
    if (target) {
      target.cards.push(card);
      target.cards.sort(compareCards);
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
    await Promise.all([loadBoard(), loadLabels()]);
    render();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();

document.addEventListener('click', (e) => {
  if (!e.target.closest('.label-dropdown') && !e.target.closest('.assign-label-btn')) {
    document.querySelectorAll('.label-dropdown').forEach(d => d.classList.add('hidden'));
  }
});
