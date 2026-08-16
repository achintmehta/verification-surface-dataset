import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedLabels = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let isLabelManagerOpen = false;
let openCardLabelPickerId = null;

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
    <div class="toolbar">
      <div class="filter-bar">
        <strong>Filter:</strong>
        ${labels.map(l => `
          <label class="filter-label">
            <input type="checkbox" value="${escapeHtml(l.id)}" ${selectedLabels.has(l.id) ? 'checked' : ''} class="filter-checkbox">
            <span class="chip" style="background: ${escapeHtml(l.color)}">${escapeHtml(l.name)}</span>
          </label>
        `).join('')}
        ${selectedLabels.size > 0 ? `<button class="clear-filter">Clear</button>` : ''}
      </div>
      <button class="manage-labels-btn">Manage Labels</button>
    </div>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    <dialog id="label-manager">
      <div class="label-manager-content">
        <h2>Manage Labels</h2>
        <div class="label-list">
          ${labels.map(l => `
            <div class="label-item" data-id="${escapeHtml(l.id)}">
              <input type="color" value="${escapeHtml(l.color)}" class="edit-label-color">
              <input type="text" value="${escapeHtml(l.name)}" class="edit-label-name">
              <button type="button" class="save-label-btn">Save</button>
              <button type="button" class="delete-label-btn">Delete</button>
            </div>
          `).join('')}
        </div>
        <h3>Create Label</h3>
        <div class="create-label">
          <input type="color" id="new-label-color" value="#2563eb">
          <input type="text" id="new-label-name" placeholder="Label name">
          <button type="button" id="create-label-btn">Create</button>
        </div>
        <div class="dialog-actions">
          <button type="button" class="close-dialog-btn">Close</button>
        </div>
      </div>
    </dialog>
  `;
  if (isLabelManagerOpen) {
    const dialog = document.getElementById('label-manager');
    if (dialog) dialog.showModal();
  }
  bindEvents();
}

function renderColumn(column) {
  const visibleCards = column.cards.filter(card => {
    if (selectedLabels.size === 0) return true;
    if (!card.labels) return false;
    return card.labels.some(l => selectedLabels.has(l.id));
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
        ${cardLabels.map(l => `<span class="chip" style="background: ${escapeHtml(l.color)}">${escapeHtml(l.name)}</span>`).join('')}
        <button class="add-label-btn" data-card-id="${escapeHtml(card.id)}">+</button>
      </div>
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-label-picker" style="display: ${openCardLabelPickerId === card.id ? 'block' : 'none'};" data-card-id="${escapeHtml(card.id)}">
        ${labels.map(l => {
          const hasLabel = cardLabels.some(cl => cl.id === l.id);
          return `
            <label>
              <input type="checkbox" class="card-label-checkbox" data-label-id="${escapeHtml(l.id)}" ${hasLabel ? 'checked' : ''}>
              <span class="chip" style="background: ${escapeHtml(l.color)}">${escapeHtml(l.name)}</span>
            </label>
          `;
        }).join('')}
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
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    cardEl.addEventListener('dragend', () => {
      draggedCardId = null;
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.cards').forEach((c) => c.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((cardsEl) => {
    cardsEl.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      cardsEl.classList.add('drop-target');
    });
    cardsEl.addEventListener('dragleave', () => {
      cardsEl.classList.remove('drop-target');
    });
    cardsEl.addEventListener('drop', async (event) => {
      event.preventDefault();
      cardsEl.classList.remove('drop-target');
      if (!draggedCardId) return;

      const columnId = cardsEl.dataset.columnId;
      const { beforeId, afterId } = getDropPosition(cardsEl, event.clientY, draggedCardId);
      const cardId = draggedCardId;

      optimisticMove(cardId, columnId, beforeId, afterId);
      render();

      try {
        const response = await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
      } catch (error) {
        setStatus(`Move failed: ${error.message}`, true);
        await loadBoard();
      }
    });
  });

  document.querySelector('.manage-labels-btn')?.addEventListener('click', () => {
    isLabelManagerOpen = true;
    render();
  });

  document.querySelector('.close-dialog-btn')?.addEventListener('click', () => {
    isLabelManagerOpen = false;
    render();
  });

  document.getElementById('label-manager')?.addEventListener('close', () => {
    isLabelManagerOpen = false;
    render();
  });

  document.getElementById('create-label-btn')?.addEventListener('click', async () => {
    const nameInput = document.getElementById('new-label-name');
    const colorInput = document.getElementById('new-label-color');
    const name = nameInput.value.trim();
    const color = colorInput.value;
    if (!name) return;
    try {
      const response = await fetch(`${API_BASE}/api/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color }),
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Create label failed');
      nameInput.value = '';
    } catch (error) {
      alert(error.message);
    }
  });

  document.querySelectorAll('.save-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const item = e.target.closest('.label-item');
      const id = item.dataset.id;
      const name = item.querySelector('.edit-label-name').value.trim();
      const color = item.querySelector('.edit-label-color').value;
      if (!name) return;
      try {
        const response = await fetch(`${API_BASE}/api/labels/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Update label failed');
      } catch (error) {
        alert(error.message);
      }
    });
  });

  document.querySelectorAll('.delete-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const item = e.target.closest('.label-item');
      const id = item.dataset.id;
      try {
        const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
        if (!response.ok) throw new Error((await response.json()).error || 'Delete label failed');
      } catch (error) {
        alert(error.message);
      }
    });
  });

  document.querySelectorAll('.filter-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedLabels.add(e.target.value);
      } else {
        selectedLabels.delete(e.target.value);
      }
      render();
    });
  });

  document.querySelector('.clear-filter')?.addEventListener('click', () => {
    selectedLabels.clear();
    render();
  });

  document.querySelectorAll('.add-label-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const cardId = e.target.dataset.cardId;
      openCardLabelPickerId = openCardLabelPickerId === cardId ? null : cardId;
      render();
    });
  });

  document.querySelectorAll('.card-label-checkbox').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      const cardId = e.target.closest('.card-label-picker').dataset.cardId;
      const labelId = e.target.dataset.labelId;
      const isChecked = e.target.checked;
      try {
        let response;
        if (isChecked) {
          response = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId }),
          });
        } else {
          response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
            method: 'DELETE'
          });
        }
        if (!response.ok) throw new Error((await response.json()).error || 'Toggle label failed');
      } catch (error) {
        alert(error.message);
      }
    });
  });
}

function getDropPosition(list, clientY, cardId) {
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

  if (message.type === 'create_label' || message.type === 'update_label' || message.type === 'delete_label') {
    if (message.type === 'create_label') {
      labels.push(message.label);
      labels.sort((a, b) => a.name.localeCompare(b.name));
    } else if (message.type === 'update_label') {
      const index = labels.findIndex(l => l.id === message.label.id);
      if (index !== -1) labels[index] = message.label;
      labels.sort((a, b) => a.name.localeCompare(b.name));
      for (const col of board.columns) {
        for (const card of col.cards) {
          const lIndex = card.labels?.findIndex(l => l.id === message.label.id);
          if (lIndex !== -1 && lIndex !== undefined) {
            card.labels[lIndex] = message.label;
          }
        }
      }
    } else if (message.type === 'delete_label') {
      labels = labels.filter(l => l.id !== message.labelId);
      selectedLabels.delete(message.labelId);
      for (const col of board.columns) {
        for (const card of col.cards) {
          if (card.labels) {
            card.labels = card.labels.filter(l => l.id !== message.labelId);
          }
        }
      }
    }
    render();
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
  labels.sort((a, b) => a.name.localeCompare(b.name));
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
