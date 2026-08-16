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
  const labelChips = labels.map((label) => {
    const selected = selectedLabelIds.has(label.id);
    return `<button class="label-chip ${selected ? 'selected' : ''}" data-label-id="${escapeHtml(label.id)}" style="background:${escapeHtml(label.color)}; color: white; border: none; padding: 0.25rem 0.6rem; border-radius: 999px; cursor: pointer; margin-right: 0.35rem; font-size: 0.75rem; ${selected ? 'box-shadow: 0 0 0 2px #172033;' : ''}">${escapeHtml(label.name)}</button>`;
  }).join('');

  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="label-controls">
      <div class="filter-bar">
        <span class="filter-label">Filter by labels:</span>
        <div class="label-filters">${labelChips || '<span class="no-labels">No labels yet</span>'}</div>
        <button id="clear-filter" class="small-btn">Clear</button>
      </div>
      <div class="label-manager">
        <button id="manage-labels" class="small-btn">Manage Labels</button>
      </div>
    </div>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    <div id="label-modal" class="modal" style="display:none;">
      <div class="modal-content">
        <h3>Manage Labels</h3>
        <form id="create-label-form" class="create-label">
          <input name="name" type="text" placeholder="Label name" maxlength="50" required />
          <input name="color" type="color" value="#3b82f6" />
          <button type="submit">Create</button>
        </form>
        <div id="label-list" class="label-list"></div>
        <button id="close-modal" class="small-btn">Close</button>
      </div>
    </div>
  `;
  bindEvents();
  renderLabelList();
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
    `<span class="card-label" style="background:${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}">${escapeHtml(label.name)}</span>`
  ).join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${chips ? `<div class="card-labels">${chips}</div>` : ''}
      <div class="card-actions">
        <button class="assign-label-btn" data-card-id="${escapeHtml(card.id)}" title="Assign label">+</button>
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

  // Label filter clicks
  document.querySelectorAll('.label-filters .label-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.labelId;
      if (selectedLabelIds.has(id)) {
        selectedLabelIds.delete(id);
      } else {
        selectedLabelIds.add(id);
      }
      filterBoard();
    });
  });

  document.getElementById('clear-filter')?.addEventListener('click', () => {
    selectedLabelIds.clear();
    filterBoard();
  });

  // Manage labels modal
  document.getElementById('manage-labels')?.addEventListener('click', () => {
    const modal = document.getElementById('label-modal');
    if (modal) modal.style.display = 'flex';
    renderLabelList();
  });
  document.getElementById('close-modal')?.addEventListener('click', () => {
    const modal = document.getElementById('label-modal');
    if (modal) modal.style.display = 'none';
  });

  // Create label form
  const createForm = document.getElementById('create-label-form');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
      if (!name) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Create failed');
        }
        createForm.reset();
        await loadLabels();
        render();
      } catch (err) {
        alert(err.message);
      }
    });
  }

  // Card drag etc.
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

    // Assign label button
    const assignBtn = cardEl.querySelector('.assign-label-btn');
    if (assignBtn) {
      assignBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        showAssignMenu(assignBtn, cardEl.dataset.cardId);
      });
    }

    // Click label chip to unassign? or filter, but for now simple
    cardEl.querySelectorAll('.card-label').forEach((chip) => {
      chip.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const labelId = chip.dataset.labelId;
        const cardId = cardEl.dataset.cardId;
        await unassignLabel(cardId, labelId);
      });
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

function filterBoard() {
  // Re-render with filter applied client-side
  const filteredBoard = {
    columns: board.columns.map((col) => ({
      ...col,
      cards: col.cards.filter((card) => {
        if (selectedLabelIds.size === 0) return true;
        const cardLabelIds = (card.labels || []).map((l) => l.id);
        return cardLabelIds.some((id) => selectedLabelIds.has(id));
      })
    }))
  };
  const originalBoard = board;
  board = filteredBoard;
  const main = document.querySelector('.board');
  if (main) {
    main.innerHTML = board.columns.map(renderColumn).join('');
    // rebind only card events for filtered view
    bindCardEvents();
  }
  board = originalBoard; // keep full for mutations
}

function bindCardEvents() {
  // minimal rebind for filtered cards
  document.querySelectorAll('.card').forEach((cardEl) => {
    // drag handlers omitted for brevity, assume full reload on mutation
    const assignBtn = cardEl.querySelector('.assign-label-btn');
    if (assignBtn) {
      assignBtn.onclick = (ev) => {
        ev.stopPropagation();
        showAssignMenu(assignBtn, cardEl.dataset.cardId);
      };
    }
    cardEl.querySelectorAll('.card-label').forEach((chip) => {
      chip.onclick = async (ev) => {
        ev.stopPropagation();
        await unassignLabel(cardEl.dataset.cardId, chip.dataset.labelId);
      };
    });
  });
}

function showAssignMenu(btn, cardId) {
  // simple prompt or select for labels not assigned
  const currentCard = findCard(cardId);
  const assigned = new Set((currentCard?.card.labels || []).map(l => l.id));
  const available = labels.filter(l => !assigned.has(l.id));
  if (available.length === 0) {
    alert('All labels assigned or no labels');
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'label-menu';
  menu.innerHTML = available.map(l => `<div class="menu-item" data-id="${l.id}" style="background:${l.color}">${escapeHtml(l.name)}</div>`).join('');
  document.body.appendChild(menu);
  menu.style.position = 'absolute';
  menu.style.left = `${btn.getBoundingClientRect().left}px`;
  menu.style.top = `${btn.getBoundingClientRect().bottom + 4}px`;
  menu.querySelectorAll('.menu-item').forEach(item => {
    item.onclick = async () => {
      await assignLabel(cardId, item.dataset.id);
      document.body.removeChild(menu);
    };
  });
  setTimeout(() => {
    document.addEventListener('click', function handler(ev) {
      if (!menu.contains(ev.target)) {
        document.removeEventListener('click', handler);
        if (menu.parentNode) menu.parentNode.removeChild(menu);
      }
    }, { once: true });
  }, 0);
}

async function assignLabel(cardId, labelId) {
  try {
    const res = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!res.ok) throw new Error('Assign failed');
    await loadBoard();
  } catch (e) {
    setStatus(e.message, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const res = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('Unassign failed');
    await loadBoard();
  } catch (e) {
    setStatus(e.message, true);
  }
}

function renderLabelList() {
  const container = document.getElementById('label-list');
  if (!container) return;
  container.innerHTML = labels.map(label => `
    <div class="label-row" data-id="${escapeHtml(label.id)}">
      <span class="label-chip" style="background:${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
      <input class="edit-name" value="${escapeHtml(label.name)}" />
      <input class="edit-color" type="color" value="${escapeHtml(label.color)}" />
      <button class="save-label small-btn">Save</button>
      <button class="delete-label small-btn">Delete</button>
    </div>
  `).join('');

  container.querySelectorAll('.save-label').forEach((btn, idx) => {
    btn.onclick = async () => {
      const row = btn.closest('.label-row');
      const id = row.dataset.id;
      const name = row.querySelector('.edit-name').value.trim();
      const color = row.querySelector('.edit-color').value;
      if (!name) return;
      const res = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error);
        return;
      }
      await loadLabels();
      render();
    };
  });

  container.querySelectorAll('.delete-label').forEach((btn) => {
    btn.onclick = async () => {
      const row = btn.closest('.label-row');
      const id = row.dataset.id;
      if (!confirm('Delete label?')) return;
      await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadLabels();
      render();
    };
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
    // labels may have changed too, reload labels on label mutations
    if (message.type && message.type.startsWith('label')) {
      loadLabels().then(() => render());
    } else {
      render();
    }
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
  if (response.ok) {
    labels = await response.json();
  }
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
