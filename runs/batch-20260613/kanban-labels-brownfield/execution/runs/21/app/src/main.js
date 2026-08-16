import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];
let activeFilterLabelIds = new Set();
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
        .map((card) => ({ ...card, labels: card.labels || [] }))
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  return { columns };
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function cardPassesFilter(card) {
  if (activeFilterLabelIds.size === 0) return true;
  const cardLabelIds = (card.labels || []).map((l) => l.id);
  for (const filterId of activeFilterLabelIds) {
    if (cardLabelIds.includes(filterId)) return true;
  }
  return false;
}

function getContrastColor(hexColor) {
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.length === 3 ? hex[0]+hex[0] : hex.substring(0,2), 16);
  const g = parseInt(hex.length === 3 ? hex[1]+hex[1] : hex.substring(2,4), 16);
  const b = parseInt(hex.length === 3 ? hex[2]+hex[2] : hex.substring(4,6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
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
    ${renderFilterBar()}
    ${renderLabelManager()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderFilterBar() {
  if (allLabels.length === 0) return '';
  return `
    <div class="filter-bar">
      <span class="filter-bar-title">Filter by label:</span>
      ${allLabels.map((label) => {
        const active = activeFilterLabelIds.has(label.id);
        return `<button class="filter-chip ${active ? 'active' : ''}" data-filter-label-id="${escapeHtml(label.id)}"
          style="background:${active ? escapeHtml(label.color) : '#e2e8f0'};color:${active ? getContrastColor(label.color) : '#334155'}"
        >${escapeHtml(label.name)}</button>`;
      }).join('')}
      ${activeFilterLabelIds.size > 0 ? '<button class="filter-clear">Clear filter</button>' : ''}
    </div>
  `;
}

function renderLabelManager() {
  return `
    <details class="label-manager">
      <summary>Manage Labels</summary>
      <div class="label-manager-content">
        <form class="label-create-form">
          <input name="labelName" type="text" placeholder="Label name…" maxlength="50" autocomplete="off" />
          <input name="labelColor" type="color" value="#2563eb" />
          <button type="submit">Create</button>
        </form>
        <div class="label-list">
          ${allLabels.map((label) => `
            <div class="label-list-item" data-label-id="${escapeHtml(label.id)}">
              <span class="label-chip" style="background:${escapeHtml(label.color)};color:${getContrastColor(label.color)}">${escapeHtml(label.name)}</span>
              <input type="text" class="label-edit-name" value="${escapeHtml(label.name)}" maxlength="50" />
              <input type="color" class="label-edit-color" value="${escapeHtml(label.color)}" />
              <button class="label-save-btn" title="Save">💾</button>
              <button class="label-delete-btn" title="Delete">🗑️</button>
            </div>
          `).join('')}
        </div>
      </div>
    </details>
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
        ${column.cards.map((card) => renderCard(card, !cardPassesFilter(card))).join('')}
      </div>
    </section>
  `;
}

function renderCard(card, hidden) {
  const labelsHtml = (card.labels || []).map((label) =>
    `<span class="card-label-chip" style="background:${escapeHtml(label.color)};color:${getContrastColor(label.color)}" data-label-id="${escapeHtml(label.id)}">${escapeHtml(label.name)}</span>`
  ).join('');

  const assignedIds = new Set((card.labels || []).map((l) => l.id));
  const unassigned = allLabels.filter((l) => !assignedIds.has(l.id));

  return `
    <article class="card ${hidden ? 'card-hidden' : ''}" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml ? `<div class="card-labels">${labelsHtml}</div>` : ''}
      <div class="card-label-actions">
        ${unassigned.length > 0 ? `
          <select class="label-assign-select" data-card-id="${escapeHtml(card.id)}">
            <option value="">+ Label</option>
            ${unassigned.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('')}
          </select>
        ` : ''}
        ${(card.labels || []).length > 0 ? `
          <select class="label-unassign-select" data-card-id="${escapeHtml(card.id)}">
            <option value="">- Label</option>
            ${(card.labels || []).map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('')}
          </select>
        ` : ''}
      </div>
    </article>
  `;
}

function bindEvents() {
  // Add-card forms
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      if (text) {
        input.value = '';
        await createCard(form.dataset.columnId, text);
      }
    });
  });

  // Drag-and-drop
  document.querySelectorAll('.card').forEach((el) => {
    el.addEventListener('dragstart', (event) => {
      draggedCardId = el.dataset.cardId;
      el.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      draggedCardId = null;
      document.querySelectorAll('.drop-target').forEach((d) => d.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      list.classList.add('drop-target');
      const dragging = document.querySelector('.card.dragging');
      if (!dragging) return;
      const after = closestDragSibling(list, event.clientY);
      if (after) list.insertBefore(dragging, after);
      else list.appendChild(dragging);
    });
    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) list.classList.remove('drop-target');
    });
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      const cardId = event.dataTransfer.getData('text/plain');
      if (!cardId) return;
      const columnId = list.dataset.columnId;
      const { afterId, beforeId } = adjacentIds(list, cardId);
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
        board = normalizeBoard(await (await fetch(`${API_BASE}/api/board`)).json());
        render();
      }
    });
  });

  // Filter bar
  document.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const labelId = btn.dataset.filterLabelId;
      if (activeFilterLabelIds.has(labelId)) {
        activeFilterLabelIds.delete(labelId);
      } else {
        activeFilterLabelIds.add(labelId);
      }
      render();
    });
  });

  document.querySelector('.filter-clear')?.addEventListener('click', () => {
    activeFilterLabelIds.clear();
    render();
  });

  // Label manager: create
  document.querySelector('.label-create-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const name = form.labelName.value.trim();
    const color = form.labelColor.value;
    if (!name) return;
    try {
      const response = await fetch(`${API_BASE}/api/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color }),
      });
      if (!response.ok) {
        const data = await response.json();
        setStatus(`Label error: ${data.error}`, true);
        return;
      }
      form.labelName.value = '';
    } catch (error) {
      setStatus(`Label create failed: ${error.message}`, true);
    }
  });

  // Label manager: save (rename/recolor)
  document.querySelectorAll('.label-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = btn.closest('.label-list-item');
      const labelId = item.dataset.labelId;
      const name = item.querySelector('.label-edit-name').value.trim();
      const color = item.querySelector('.label-edit-color').value;
      if (!name) return;
      try {
        const response = await fetch(`${API_BASE}/api/labels/${labelId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!response.ok) {
          const data = await response.json();
          setStatus(`Label update error: ${data.error}`, true);
        }
      } catch (error) {
        setStatus(`Label update failed: ${error.message}`, true);
      }
    });
  });

  // Label manager: delete
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = btn.closest('.label-list-item');
      const labelId = item.dataset.labelId;
      try {
        const response = await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
        if (!response.ok) {
          const data = await response.json();
          setStatus(`Label delete error: ${data.error}`, true);
        }
      } catch (error) {
        setStatus(`Label delete failed: ${error.message}`, true);
      }
    });
  });

  // Card label assign
  document.querySelectorAll('.label-assign-select').forEach((select) => {
    select.addEventListener('change', async () => {
      const cardId = select.dataset.cardId;
      const labelId = select.value;
      if (!labelId) return;
      try {
        const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labelId }),
        });
        if (!response.ok) {
          const data = await response.json();
          setStatus(`Assign error: ${data.error}`, true);
        }
      } catch (error) {
        setStatus(`Assign failed: ${error.message}`, true);
      }
    });
  });

  // Card label unassign
  document.querySelectorAll('.label-unassign-select').forEach((select) => {
    select.addEventListener('change', async () => {
      const cardId = select.dataset.cardId;
      const labelId = select.value;
      if (!labelId) return;
      try {
        const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
          method: 'DELETE',
        });
        if (!response.ok) {
          const data = await response.json();
          setStatus(`Unassign error: ${data.error}`, true);
        }
      } catch (error) {
        setStatus(`Unassign failed: ${error.message}`, true);
      }
    });
  });
}

function closestDragSibling(list, y) {
  const cards = [...list.querySelectorAll('.card:not(.dragging)')];
  let closest = null;
  let closestOffset = Number.NEGATIVE_INFINITY;
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = card;
    }
  }
  return closest;
}

function adjacentIds(list, cardId) {
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
  // Handle label-specific mutations
  if (message.type === 'label-created') {
    if (message.label && !allLabels.find((l) => l.id === message.label.id)) {
      allLabels.push(message.label);
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-updated') {
    if (message.label) {
      const idx = allLabels.findIndex((l) => l.id === message.label.id);
      if (idx !== -1) allLabels[idx] = message.label;
      else allLabels.push(message.label);
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-deleted') {
    if (message.labelId) {
      allLabels = allLabels.filter((l) => l.id !== message.labelId);
      activeFilterLabelIds.delete(message.labelId);
    }
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-assigned' || message.type === 'label-unassigned') {
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }

  // Original mutation handling
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
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
}

async function loadLabels() {
  const response = await fetch(`${API_BASE}/api/labels`);
  if (!response.ok) throw new Error('Could not load labels');
  allLabels = await response.json();
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
    render();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
