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
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="controls">
        <button id="manage-labels-btn">Manage Labels</button>
        <div id="filter-bar" class="filter-bar">
          <span>Filter:</span>
          ${labels.map(label => `
            <button class="filter-chip ${selectedLabels.has(label.id) ? 'selected' : ''}" data-label-id="${escapeHtml(label.id)}" style="background-color: ${escapeHtml(label.color)}; color: #fff; text-shadow: 0 0 2px #000;">
              ${escapeHtml(label.name)}
            </button>
          `).join('')}
          ${selectedLabels.size > 0 ? `<button id="clear-filter">Clear</button>` : ''}
        </div>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    
    <dialog id="label-manager-modal" class="modal">
      <h2>Manage Labels</h2>
      <ul id="label-list" class="label-list">
        ${labels.map(l => `
          <li>
            <input type="color" value="${escapeHtml(l.color)}" data-label-id="${escapeHtml(l.id)}" class="label-color-input">
            <input type="text" value="${escapeHtml(l.name)}" data-label-id="${escapeHtml(l.id)}" class="label-name-input">
            <button class="delete-label-btn" data-label-id="${escapeHtml(l.id)}">Delete</button>
          </li>
        `).join('')}
      </ul>
      <form id="add-label-form" class="add-label-form">
        <input type="color" name="color" value="#ff0000">
        <input type="text" name="name" placeholder="New label name" required>
        <button type="submit">Add Label</button>
      </form>
      <button id="close-label-manager" style="margin-top: 1rem;">Close</button>
    </dialog>

    <dialog id="card-labels-modal" class="modal">
      <h2>Labels for Card</h2>
      <div id="card-labels-list" class="card-labels-list"></div>
      <button id="close-card-labels" style="margin-top: 1rem;">Close</button>
    </dialog>
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
  if (selectedLabels.size > 0) {
    const cardLabelIds = new Set((card.labels || []).map(l => l.id));
    let hasMatch = false;
    for (const id of selectedLabels) {
      if (cardLabelIds.has(id)) {
        hasMatch = true;
        break;
      }
    }
    if (!hasMatch) return '';
  }

  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        ${(card.labels || []).map(l => `
          <span class="label-chip" style="background-color: ${escapeHtml(l.color)}" title="${escapeHtml(l.name)}"></span>
        `).join('')}
      </div>
      <div class="card-text">${escapeHtml(card.text)}</div>
      <button class="edit-labels-btn" data-card-id="${escapeHtml(card.id)}" title="Edit Labels">🏷️</button>
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
      if (event.target.closest('.edit-labels-btn')) {
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

  // Label Manager
  const labelManagerModal = document.getElementById('label-manager-modal');
  document.getElementById('manage-labels-btn')?.addEventListener('click', () => {
    labelManagerModal.showModal();
  });
  document.getElementById('close-label-manager')?.addEventListener('click', () => {
    labelManagerModal.close();
  });

  document.getElementById('add-label-form')?.addEventListener('submit', async (e) => {
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
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to create label');
      form.reset();
      form.elements.color.value = '#ff0000';
    } catch (err) {
      alert(err.message);
    }
  });

  document.querySelectorAll('.label-name-input, .label-color-input').forEach(input => {
    input.addEventListener('change', async (e) => {
      const id = e.target.dataset.labelId;
      const li = e.target.closest('li');
      const name = li.querySelector('.label-name-input').value.trim();
      const color = li.querySelector('.label-color-input').value;
      if (!name) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
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
    btn.addEventListener('click', async (e) => {
      const id = e.target.dataset.labelId;
      if (!confirm('Delete this label?')) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
          method: 'DELETE'
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to delete label');
      } catch (err) {
        alert(err.message);
      }
    });
  });

  // Filter Bar
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      const id = e.target.dataset.labelId;
      if (selectedLabels.has(id)) {
        selectedLabels.delete(id);
      } else {
        selectedLabels.add(id);
      }
      render();
    });
  });
  document.getElementById('clear-filter')?.addEventListener('click', () => {
    selectedLabels.clear();
    render();
  });

  // Card Labels
  const cardLabelsModal = document.getElementById('card-labels-modal');
  document.querySelectorAll('.edit-labels-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const cardId = e.target.closest('.edit-labels-btn').dataset.cardId;
      const cardInfo = findCard(cardId);
      if (!cardInfo) return;
      const card = cardInfo.card;
      const cardLabelIds = new Set((card.labels || []).map(l => l.id));
      
      const listEl = document.getElementById('card-labels-list');
      listEl.innerHTML = labels.map(l => `
        <label style="display: block; margin-bottom: 0.5rem;">
          <input type="checkbox" class="card-label-checkbox" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(l.id)}" ${cardLabelIds.has(l.id) ? 'checked' : ''}>
          <span class="label-chip" style="background-color: ${escapeHtml(l.color)}; display: inline-block; width: 12px; height: 12px; border-radius: 50%;"></span>
          ${escapeHtml(l.name)}
        </label>
      `).join('');
      
      listEl.querySelectorAll('.card-label-checkbox').forEach(cb => {
        cb.addEventListener('change', async (ev) => {
          const cId = ev.target.dataset.cardId;
          const lId = ev.target.dataset.labelId;
          const checked = ev.target.checked;
          try {
            if (checked) {
              await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cId)}/labels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ labelId: lId })
              });
            } else {
              await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cId)}/labels/${encodeURIComponent(lId)}`, {
                method: 'DELETE'
              });
            }
          } catch (err) {
            alert('Failed to update card label');
            ev.target.checked = !checked;
          }
        });
      });
      
      cardLabelsModal.showModal();
    });
  });
  document.getElementById('close-card-labels')?.addEventListener('click', () => {
    cardLabelsModal.close();
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
    { offset: Number.NEGATIVE_INFINITY }
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
    }
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    return;
  }
  if (message.type === 'deleteLabel') {
    labels = labels.filter(l => l.id !== message.labelId);
    selectedLabels.delete(message.labelId);
    if (message.board) {
      board = normalizeBoard(message.board);
    }
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
