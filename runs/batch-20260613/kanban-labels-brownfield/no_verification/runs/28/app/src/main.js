import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedLabelIds = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelManagerOpen = false;

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

function getFilteredBoard() {
  if (selectedLabelIds.size === 0) return board;
  const filteredColumns = board.columns.map((column) => ({
    ...column,
    cards: column.cards.filter((card) => {
      const cardLabelIds = (card.labels || []).map((l) => l.id);
      return cardLabelIds.some((id) => selectedLabelIds.has(id));
    }),
  }));
  return { columns: filteredColumns };
}

function render() {
  const visibleBoard = getFilteredBoard();
  const filterActive = selectedLabelIds.size > 0;
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <div id="status" class="status">Connecting…</div>
        <button id="manage-labels-btn" class="manage-btn">Manage Labels</button>
      </div>
    </header>
    <div class="filter-bar">
      <span class="filter-label">Filter by labels:</span>
      <div class="label-filters">
        ${labels.length === 0 ? '<span class="no-labels">No labels yet</span>' : labels.map(renderLabelFilterChip).join('')}
      </div>
      ${filterActive ? '<button id="clear-filter" class="clear-filter">Clear</button>' : ''}
    </div>
    ${labelManagerOpen ? renderLabelManager() : ''}
    <main class="board">
      ${visibleBoard.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderLabelFilterChip(label) {
  const selected = selectedLabelIds.has(label.id);
  return `
    <span class="label-chip filter-chip ${selected ? 'selected' : ''}" data-label-id="${escapeHtml(label.id)}" style="background:${escapeHtml(label.color)}; color: white;">
      ${escapeHtml(label.name)}
    </span>
  `;
}

function renderLabelManager() {
  return `
    <div class="label-manager-modal">
      <div class="label-manager">
        <div class="manager-header">
          <h3>Label Manager</h3>
          <button id="close-manager" class="close-btn">×</button>
        </div>
        <form id="create-label-form" class="create-label-form">
          <input name="name" type="text" placeholder="Label name" maxlength="50" required />
          <input name="color" type="color" value="#3b82f6" />
          <button type="submit">Create</button>
        </form>
        <div class="labels-list">
          ${labels.length === 0 ? '<p>No labels created yet.</p>' : labels.map(renderLabelRow).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderLabelRow(label) {
  return `
    <div class="label-row" data-label-id="${escapeHtml(label.id)}">
      <span class="label-chip" style="background:${escapeHtml(label.color)}; color: white;">${escapeHtml(label.name)}</span>
      <div class="label-actions">
        <input type="text" class="rename-input" value="${escapeHtml(label.name)}" data-label-id="${escapeHtml(label.id)}" />
        <input type="color" class="recolor-input" value="${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}" />
        <button class="delete-label-btn" data-label-id="${escapeHtml(label.id)}">Delete</button>
      </div>
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
        ${column.cards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const labelChips = (card.labels || []).map(l => 
    `<span class="label-chip card-label" style="background:${escapeHtml(l.color)};" data-label-id="${escapeHtml(l.id)}">${escapeHtml(l.name)}</span>`
  ).join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">${labelChips}</div>
      <div class="card-text">${escapeHtml(card.text)}</div>
      <button class="assign-label-btn" data-card-id="${escapeHtml(card.id)}" title="Assign labels">+</button>
    </article>
  `;
}

function bindEvents() {
  // Manage labels button
  const manageBtn = document.getElementById('manage-labels-btn');
  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      labelManagerOpen = !labelManagerOpen;
      render();
    });
  }

  // Close manager
  const closeBtn = document.getElementById('close-manager');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      labelManagerOpen = false;
      render();
    });
  }

  // Create label form
  const createForm = document.getElementById('create-label-form');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = createForm.elements.name.value;
      const color = createForm.elements.color.value;
      try {
        const res = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed');
        }
        await loadLabels();
        render();
      } catch (err) {
        alert('Create label failed: ' + err.message);
      }
    });
  }

  // Label filter chips
  document.querySelectorAll('.label-chip.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.labelId;
      if (selectedLabelIds.has(id)) {
        selectedLabelIds.delete(id);
      } else {
        selectedLabelIds.add(id);
      }
      render();
    });
  });

  // Clear filter
  const clearBtn = document.getElementById('clear-filter');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      selectedLabelIds.clear();
      render();
    });
  }

  // Label manager rename/recolor/delete
  document.querySelectorAll('.rename-input').forEach((input) => {
    input.addEventListener('change', async () => {
      const id = input.dataset.labelId;
      const newName = input.value.trim();
      const label = labels.find(l => l.id === id);
      if (!label || !newName) return;
      try {
        await fetch(`${API_BASE}/api/labels/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName, color: label.color }),
        });
        await loadLabels();
        render();
      } catch (e) { alert('Rename failed'); }
    });
  });

  document.querySelectorAll('.recolor-input').forEach((input) => {
    input.addEventListener('change', async () => {
      const id = input.dataset.labelId;
      const newColor = input.value;
      const label = labels.find(l => l.id === id);
      if (!label) return;
      try {
        await fetch(`${API_BASE}/api/labels/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: label.name, color: newColor }),
        });
        await loadLabels();
        render();
      } catch (e) { alert('Recolor failed'); }
    });
  });

  document.querySelectorAll('.delete-label-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.labelId;
      if (!confirm('Delete this label?')) return;
      try {
        await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
        selectedLabelIds.delete(id);
        await loadLabels();
        render();
      } catch (e) { alert('Delete failed'); }
    });
  });

  // Add card forms
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const columnId = form.dataset.columnId;
      if (input.value.trim()) {
        await createCard(columnId, input.value);
        input.value = '';
      }
    });
  });

  // Assign label buttons on cards
  document.querySelectorAll('.assign-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showLabelPicker(btn.dataset.cardId, btn);
    });
  });

  // Drag and drop for cards
  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (e) => {
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.cards').forEach((c) => c.classList.remove('drop-target'));
      draggedCardId = null;
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      list.classList.add('drop-target');
    });
    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));
    list.addEventListener('drop', async (e) => {
      e.preventDefault();
      list.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = list.dataset.columnId;
      const { afterId, beforeId } = getDropPosition(list, draggedCardId);
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });
}

function showLabelPicker(cardId, anchorEl) {
  // Remove any existing picker
  document.querySelectorAll('.label-picker').forEach(el => el.remove());

  const card = findCard(cardId)?.card;
  const assigned = new Set((card?.labels || []).map(l => l.id));

  const picker = document.createElement('div');
  picker.className = 'label-picker';
  picker.innerHTML = `
    <div class="picker-content">
      ${labels.length ? labels.map(l => `
        <label class="picker-label">
          <input type="checkbox" ${assigned.has(l.id) ? 'checked' : ''} data-label-id="${escapeHtml(l.id)}" />
          <span class="label-chip" style="background:${escapeHtml(l.color)}">${escapeHtml(l.name)}</span>
        </label>
      `).join('') : '<div>No labels</div>'}
    </div>
  `;

  document.body.appendChild(picker);

  // Position near anchor
  const rect = anchorEl.getBoundingClientRect();
  picker.style.position = 'absolute';
  picker.style.top = `${rect.bottom + window.scrollY + 4}px`;
  picker.style.left = `${rect.left + window.scrollX}px`;

  // Handle changes
  picker.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
    checkbox.addEventListener('change', async () => {
      const labelId = checkbox.dataset.labelId;
      try {
        if (checkbox.checked) {
          await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId }),
          });
        } else {
          await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
        }
        await loadBoard();
        render();
      } catch (e) {
        alert('Label assign failed');
      }
      picker.remove();
    });
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function onClick(ev) {
      if (!picker.contains(ev.target)) {
        picker.remove();
        document.removeEventListener('click', onClick);
      }
    }, { once: true });
  }, 0);
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

async function moveCard(cardId, columnId, beforeId, afterId) {
  try {
    optimisticMove(cardId, columnId, beforeId, afterId);
    render();
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
    if (!response.ok) throw new Error('Move failed');
  } catch (error) {
    setStatus(`Move failed: ${error.message}`, true);
    await loadBoard();
  }
}

async function loadLabels() {
  try {
    const response = await fetch(`${API_BASE}/api/labels`);
    if (response.ok) {
      labels = await response.json();
    }
  } catch (e) {
    console.error('Failed to load labels', e);
  }
}

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
  await loadLabels();
}

function applyMutation(message) {
  if (message.board) {
    board = normalizeBoard(message.board);
    // also refresh labels if needed, but board has them
    render();
    setStatus('Synced');
    return;
  }

  if (message.card) {
    const card = message.card;
    removeCardEverywhere(card.id);
    const target = board.columns.find((column) => column.id === card.column_id || column.id === message.columnId);
    if (target) {
      target.cards.push(card);
      target.cards.sort(compareCards);
    }
    render();
    setStatus('Synced');
    return;
  }

  // For label mutations, just reload board to sync
  if (message.type && message.type.startsWith('label-')) {
    loadBoard().then(() => {
      render();
      setStatus('Synced');
    });
    return;
  }
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
    render();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
