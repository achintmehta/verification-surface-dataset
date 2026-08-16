import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedFilterLabels = new Set();
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

function cardMatchesFilter(card) {
  if (selectedFilterLabels.size === 0) return true;
  if (!card.labels || card.labels.length === 0) return false;
  return card.labels.some((label) => selectedFilterLabels.has(label.id));
}

function render() {
  const filteredColumns = board.columns.map((column) => ({
    ...column,
    cards: column.cards.filter((card) => cardMatchesFilter(card)),
  }));

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
      <div class="filter-label">Filter by labels:</div>
      <div class="filter-chips" id="filter-chips">
        ${labels.length ? labels.map((label) => `
          <span class="label-chip filter-chip ${selectedFilterLabels.has(label.id) ? 'selected' : ''}" 
                data-label-id="${escapeHtml(label.id)}" 
                style="background:${escapeHtml(label.color)}; color: white;">
            ${escapeHtml(label.name)}
          </span>
        `).join('') : '<span class="no-labels">No labels yet</span>'}
      </div>
      <button id="clear-filter" class="clear-filter" ${selectedFilterLabels.size ? '' : 'disabled'}>Clear</button>
    </div>
    <main class="board">
      ${filteredColumns.map(renderColumn).join('')}
    </main>
    <div id="label-modal" class="modal hidden">
      <div class="modal-content">
        <h2>Manage Labels</h2>
        <div class="label-form">
          <input id="new-label-name" type="text" placeholder="Label name" maxlength="50" />
          <input id="new-label-color" type="color" value="#3b82f6" />
          <button id="create-label-btn">Create</button>
        </div>
        <div class="labels-list" id="labels-list">
          ${renderLabelsList()}
        </div>
        <button id="close-modal-btn" class="close-btn">Close</button>
      </div>
    </div>
  `;
  bindEvents();
  bindLabelEvents();
}

function renderLabelsList() {
  if (!labels.length) return '<p class="empty">No labels created yet.</p>';
  return labels.map((label) => `
    <div class="label-row" data-label-id="${escapeHtml(label.id)}">
      <span class="label-chip" style="background:${escapeHtml(label.color)}; color: white;">${escapeHtml(label.name)}</span>
      <div class="label-actions">
        <input type="text" class="edit-name" value="${escapeHtml(label.name)}" />
        <input type="color" class="edit-color" value="${escapeHtml(label.color)}" />
        <button class="save-label">Save</button>
        <button class="delete-label">Delete</button>
      </div>
    </div>
  `).join('');
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
  const chips = (card.labels || []).map((label) => 
    `<span class="label-chip small" style="background:${escapeHtml(label.color)};" title="${escapeHtml(label.name)}"></span>`
  ).join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-labels">${chips}</div>
      <div class="card-actions">
        <button class="assign-label-btn" data-card-id="${escapeHtml(card.id)}">Labels</button>
      </div>
    </article>
  `;
}

function bindEvents() {
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

  document.querySelectorAll('.card').forEach((cardEl) => {
    const cardId = cardEl.dataset.cardId;

    cardEl.addEventListener('dragstart', (e) => {
      draggedCardId = cardId;
      cardEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.cards').forEach((c) => c.classList.remove('drop-target'));
      draggedCardId = null;
    });

    cardEl.querySelector('.assign-label-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      showAssignLabelMenu(cardId, cardEl);
    });
  });

  document.querySelectorAll('.cards').forEach((cardsEl) => {
    const columnId = cardsEl.dataset.columnId;

    cardsEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      cardsEl.classList.add('drop-target');
    });

    cardsEl.addEventListener('dragleave', () => {
      cardsEl.classList.remove('drop-target');
    });

    cardsEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      cardsEl.classList.remove('drop-target');
      if (!draggedCardId) return;

      const { afterId, beforeId } = getDropPosition(cardsEl, e.clientY, draggedCardId);
      try {
        await fetch(`${API_BASE}/api/cards/${draggedCardId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
      } catch (error) {
        setStatus(`Move failed: ${error.message}`, true);
      }
    });
  });

  // Filter chips
  const filterChips = document.getElementById('filter-chips');
  if (filterChips) {
    filterChips.querySelectorAll('.filter-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const labelId = chip.dataset.labelId;
        if (selectedFilterLabels.has(labelId)) {
          selectedFilterLabels.delete(labelId);
        } else {
          selectedFilterLabels.add(labelId);
        }
        render();
      });
    });
  }

  const clearBtn = document.getElementById('clear-filter');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      selectedFilterLabels.clear();
      render();
    });
  }

  // Manage labels button
  const manageBtn = document.getElementById('manage-labels-btn');
  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      showLabelModal();
    });
  }
}

function showAssignLabelMenu(cardId, cardEl) {
  const existingMenu = document.querySelector('.label-menu');
  if (existingMenu) existingMenu.remove();

  const menu = document.createElement('div');
  menu.className = 'label-menu';
  menu.innerHTML = `
    <div class="label-menu-content">
      <div class="menu-header">Assign labels</div>
      ${labels.length ? labels.map(label => {
        const card = findCard(cardId)?.card;
        const hasLabel = card?.labels?.some(l => l.id === label.id);
        return `
          <label class="label-option">
            <input type="checkbox" ${hasLabel ? 'checked' : ''} data-label-id="${escapeHtml(label.id)}" />
            <span class="label-chip small" style="background:${escapeHtml(label.color)}"></span>
            ${escapeHtml(label.name)}
          </label>
        `;
      }).join('') : '<div class="empty">No labels</div>'}
      <button class="close-menu">Close</button>
    </div>
  `;

  document.body.appendChild(menu);

  // Position menu near card
  const rect = cardEl.getBoundingClientRect();
  menu.style.position = 'absolute';
  menu.style.top = `${rect.bottom + window.scrollY + 5}px`;
  menu.style.left = `${rect.left + window.scrollX}px`;

  menu.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const labelId = cb.dataset.labelId;
      try {
        if (cb.checked) {
          await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId }),
          });
        } else {
          await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
            method: 'DELETE',
          });
        }
      } catch (err) {
        setStatus('Label update failed', true);
      }
    });
  });

  menu.querySelector('.close-menu').addEventListener('click', () => menu.remove());
  document.addEventListener('click', function onDocClick(ev) {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('click', onDocClick);
    }
  }, { once: true });
}

function bindLabelEvents() {
  const modal = document.getElementById('label-modal');
  if (!modal) return;

  const createBtn = document.getElementById('create-label-btn');
  if (createBtn) {
    createBtn.onclick = async () => {
      const nameInput = document.getElementById('new-label-name');
      const colorInput = document.getElementById('new-label-color');
      if (!nameInput.value.trim()) return;
      try {
        await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nameInput.value, color: colorInput.value }),
        });
        nameInput.value = '';
        await loadLabels();
        updateLabelsList();
      } catch (e) {
        alert('Failed to create label: ' + e.message);
      }
    };
  }

  const closeBtn = document.getElementById('close-modal-btn');
  if (closeBtn) closeBtn.onclick = () => modal.classList.add('hidden');

  // Bind save/delete for existing labels
  modal.querySelectorAll('.label-row').forEach((row) => {
    const labelId = row.dataset.labelId;
    const saveBtn = row.querySelector('.save-label');
    const delBtn = row.querySelector('.delete-label');
    const nameInput = row.querySelector('.edit-name');
    const colorInput = row.querySelector('.edit-color');

    if (saveBtn) {
      saveBtn.onclick = async () => {
        try {
          await fetch(`${API_BASE}/api/labels/${labelId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: nameInput.value, color: colorInput.value }),
          });
          await loadLabels();
          updateLabelsList();
          render();
        } catch (e) {
          alert('Update failed');
        }
      };
    }
    if (delBtn) {
      delBtn.onclick = async () => {
        if (!confirm('Delete this label?')) return;
        try {
          await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
          await loadLabels();
          updateLabelsList();
          render();
        } catch (e) {
          alert('Delete failed');
        }
      };
    }
  });
}

function updateLabelsList() {
  const listEl = document.getElementById('labels-list');
  if (listEl) {
    listEl.innerHTML = renderLabelsList();
    // rebind
    const modal = document.getElementById('label-modal');
    if (modal) {
      modal.querySelectorAll('.label-row').forEach((row) => {
        const labelId = row.dataset.labelId;
        const saveBtn = row.querySelector('.save-label');
        const delBtn = row.querySelector('.delete-label');
        const nameInput = row.querySelector('.edit-name');
        const colorInput = row.querySelector('.edit-color');

        if (saveBtn) saveBtn.onclick = async () => {
          try {
            await fetch(`${API_BASE}/api/labels/${labelId}`, {
              method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: nameInput.value, color: colorInput.value })
            });
            await loadLabels(); updateLabelsList(); render();
          } catch {}
        };
        if (delBtn) delBtn.onclick = async () => {
          if (!confirm('Delete label?')) return;
          try {
            await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
            await loadLabels(); updateLabelsList(); render();
          } catch {}
        };
      });
    }
  }
}

function showLabelModal() {
  const modal = document.getElementById('label-modal');
  if (modal) {
    modal.classList.remove('hidden');
    updateLabelsList();
  }
}

function getDropPosition(list, clientY, excludeId) {
  const ids = [...list.querySelectorAll('.card')].map((el) => el.dataset.cardId).filter(id => id !== excludeId);
  let insertIndex = ids.length;
  for (let i = 0; i < ids.length; i++) {
    const el = list.querySelector(`[data-card-id="${ids[i]}"]`);
    if (el) {
      const rect = el.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        insertIndex = i;
        break;
      }
    }
  }
  const afterId = insertIndex > 0 ? ids[insertIndex - 1] : null;
  const beforeId = insertIndex < ids.length ? ids[insertIndex] : null;
  return { afterId, beforeId };
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

async function loadLabels() {
  try {
    const res = await fetch(`${API_BASE}/api/labels`);
    if (res.ok) {
      const data = await res.json();
      labels = data.labels || [];
    }
  } catch {}
}

function applyMutation(message) {
  if (message.board) {
    board = normalizeBoard(message.board);
    // also refresh labels if needed
    render();
    setStatus('Synced');
    return;
  }

  if (message.type && message.type.startsWith('label-')) {
    // label mutation, reload board and labels
    loadBoard().then(() => loadLabels().then(render));
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
  await loadLabels();
}

function connectStream() {
  eventSource?.close();
  eventSource = new EventSource(`${API_BASE}/api/stream`);
  eventSource.addEventListener('connected', () => setStatus('Live'));
  eventSource.addEventListener('mutation', (event) => {
    const message = JSON.parse(event.data);
    applyMutation(message);
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
    render();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
