import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [], labels: [] };
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let selectedLabelIds = new Set();

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
  return { columns, labels: nextBoard.labels || [] };
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function cardMatchesFilter(card) {
  if (selectedLabelIds.size === 0) return true;
  const cardLabels = card.labels || [];
  return cardLabels.some((l) => selectedLabelIds.has(l.id));
}

function toggleLabelFilter(labelId, isSelected) {
  if (isSelected) {
    selectedLabelIds.add(labelId);
  } else {
    selectedLabelIds.delete(labelId);
  }
  // re-render board only, keep modal state? but simple re-render whole
  render();
}

async function showAssignLabelMenu(cardId, anchorEl) {
  // simple prompt based assign for minimal UI
  const labels = board.labels || [];
  if (labels.length === 0) {
    alert('No labels exist. Create via Manage Labels.');
    return;
  }
  const currentCard = findCard(cardId)?.card;
  const currentLabelIds = new Set((currentCard?.labels || []).map(l => l.id));
  const options = labels.map(l => `${currentLabelIds.has(l.id) ? '✓ ' : ''}${l.name} (${l.id.slice(0,4)})`).join('\n');
  const choice = prompt(`Enter label name or id to toggle assign/unassign:\n${options}`);
  if (!choice) return;
  const match = labels.find(l => l.name.toLowerCase() === choice.toLowerCase().trim() || l.id === choice.trim());
  if (!match) {
    alert('Label not found');
    return;
  }
  const isAssigned = currentLabelIds.has(match.id);
  try {
    if (isAssigned) {
      await fetch(`${API_BASE}/api/cards/${cardId}/labels/${match.id}`, { method: 'DELETE' });
    } else {
      await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labelId: match.id }),
      });
    }
  } catch (e) {
    alert('Assign failed: ' + e.message);
  }
}

function render() {
  const allLabels = board.labels || [];
  const filterActive = selectedLabelIds.size > 0;
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="labels-bar">
      <div class="labels-header">
        <span class="labels-title">Labels</span>
        <button id="manage-labels-btn" type="button">Manage Labels</button>
      </div>
      <div class="label-filters">
        ${allLabels.length === 0 ? '<span class="no-labels">No labels yet. Create some via Manage.</span>' : ''}
        ${allLabels.map((label) => `
          <label class="label-filter-chip ${selectedLabelIds.has(label.id) ? 'selected' : ''}" style="--label-color: ${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}">
            <input type="checkbox" ${selectedLabelIds.has(label.id) ? 'checked' : ''} />
            <span class="chip">${escapeHtml(label.name)}</span>
          </label>
        `).join('')}
      </div>
    </div>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    <div id="label-modal" class="modal hidden">
      <div class="modal-content">
        <h3>Manage Labels</h3>
        <form id="create-label-form" class="label-form">
          <input name="name" type="text" placeholder="Label name" maxlength="50" required />
          <input name="color" type="color" value="#3b82f6" />
          <button type="submit">Create</button>
        </form>
        <div id="label-list" class="label-list">
          ${allLabels.map(renderLabelRow).join('')}
        </div>
        <button id="close-modal-btn" type="button">Close</button>
      </div>
    </div>
  `;
  bindEvents();
}

function renderColumn(column) {
  const visibleCards = column.cards.filter(cardMatchesFilter);
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
  const labelsHtml = (card.labels || []).map((label) => `
    <span class="label-chip" style="background:${escapeHtml(label.color)}; color: white;" data-label-id="${escapeHtml(label.id)}">${escapeHtml(label.name)}</span>
  `).join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml ? `<div class="card-labels">${labelsHtml}</div>` : ''}
      <div class="card-actions">
        <button class="assign-label-btn" data-card-id="${escapeHtml(card.id)}" title="Assign label">🏷️</button>
      </div>
    </article>
  `;
}

function renderLabelRow(label) {
  return `
    <div class="label-row" data-label-id="${escapeHtml(label.id)}">
      <span class="label-chip" style="background:${escapeHtml(label.color)}; color: white;">${escapeHtml(label.name)}</span>
      <input class="label-name-input" type="text" value="${escapeHtml(label.name)}" />
      <input class="label-color-input" type="color" value="${escapeHtml(label.color)}" />
      <button class="save-label-btn">Save</button>
      <button class="delete-label-btn">Delete</button>
    </div>
  `;
}

function bindEvents() {
  // label filter chips
  document.querySelectorAll('.label-filter-chip').forEach((chip) => {
    const labelId = chip.dataset.labelId;
    const checkbox = chip.querySelector('input');
    chip.addEventListener('click', (e) => {
      if (e.target === checkbox) return;
      checkbox.checked = !checkbox.checked;
      toggleLabelFilter(labelId, checkbox.checked);
    });
    checkbox.addEventListener('change', () => {
      toggleLabelFilter(labelId, checkbox.checked);
    });
  });

  // manage labels
  const manageBtn = document.getElementById('manage-labels-btn');
  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      const modal = document.getElementById('label-modal');
      if (modal) modal.classList.remove('hidden');
    });
  }
  const closeBtn = document.getElementById('close-modal-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      const modal = document.getElementById('label-modal');
      if (modal) modal.classList.add('hidden');
      render();
    });
  }

  // create label form
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
        if (!res.ok) throw new Error((await res.json()).error || 'Failed');
        createForm.reset();
      } catch (err) {
        alert('Create label failed: ' + err.message);
      }
    });
  }

  // label row actions in modal
  document.querySelectorAll('.label-row').forEach((row) => {
    const labelId = row.dataset.labelId;
    const saveBtn = row.querySelector('.save-label-btn');
    const delBtn = row.querySelector('.delete-label-btn');
    const nameInput = row.querySelector('.label-name-input');
    const colorInput = row.querySelector('.label-color-input');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        try {
          const res = await fetch(`${API_BASE}/api/labels/${labelId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: nameInput.value, color: colorInput.value }),
          });
          if (!res.ok) throw new Error((await res.json()).error || 'Failed');
        } catch (err) {
          alert('Update failed: ' + err.message);
        }
      });
    }
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirm('Delete this label?')) return;
        try {
          const res = await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
          if (!res.ok) throw new Error((await res.json()).error || 'Failed');
        } catch (err) {
          alert('Delete failed: ' + err.message);
        }
      });
    }
  });

  // assign label buttons on cards
  document.querySelectorAll('.assign-label-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      await showAssignLabelMenu(cardId, btn);
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
