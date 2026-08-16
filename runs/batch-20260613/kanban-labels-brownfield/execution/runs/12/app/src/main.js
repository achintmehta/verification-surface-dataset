import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelManagerOpen = false;
let openCardMenuId = null;

function labelById(id) {
  return labels.find((label) => label.id === id) || null;
}

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
        <button id="manage-labels" type="button" class="ghost-btn">Manage labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${labelManagerOpen ? renderLabelManager() : ''}
  `;
  bindEvents();
}

function renderFilterBar() {
  if (labels.length === 0) {
    return '<div class="filter-bar empty">No labels yet. Use “Manage labels” to create some.</div>';
  }
  return `
    <div class="filter-bar">
      <span class="filter-label">Filter:</span>
      ${labels
        .map((label) => {
          const active = activeFilter.has(label.id);
          return `<button type="button" class="filter-chip${active ? ' active' : ''}" data-filter-id="${escapeHtml(label.id)}" style="--chip:${escapeHtml(label.color)}">
            <span class="dot"></span>${escapeHtml(label.name)}
          </button>`;
        })
        .join('')}
      ${activeFilter.size > 0 ? '<button type="button" class="filter-clear" id="clear-filter">Clear</button>' : ''}
    </div>
  `;
}

function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  const cardLabels = card.labels || [];
  return cardLabels.some((label) => activeFilter.has(label.id));
}

function renderLabelManager() {
  return `
    <div class="modal-backdrop" id="label-modal-backdrop">
      <div class="modal" role="dialog" aria-label="Manage labels">
        <div class="modal-header">
          <h2>Labels</h2>
          <button type="button" class="ghost-btn" id="close-label-modal">Close</button>
        </div>
        <ul class="label-list">
          ${labels.length === 0 ? '<li class="empty">No labels yet.</li>' : labels.map(renderLabelRow).join('')}
        </ul>
        <form class="label-create" id="label-create-form">
          <input name="name" type="text" maxlength="100" placeholder="New label name" autocomplete="off" />
          <input name="color" type="color" value="#2563eb" />
          <button type="submit">Add label</button>
        </form>
      </div>
    </div>
  `;
}

function renderLabelRow(label) {
  return `
    <li class="label-row" data-label-id="${escapeHtml(label.id)}">
      <input class="label-name-input" type="text" maxlength="100" value="${escapeHtml(label.name)}" />
      <input class="label-color-input" type="color" value="${escapeHtml(toHex6(label.color))}" />
      <button type="button" class="label-save-btn" data-action="save">Save</button>
      <button type="button" class="label-delete-btn" data-action="delete">Delete</button>
    </li>
  `;
}

function toHex6(color) {
  const value = String(color || '').trim();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    return '#' + value.slice(1).split('').map((c) => c + c).join('');
  }
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  return '#2563eb';
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
        ${column.cards.filter(cardMatchesFilter).map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const cardLabels = card.labels || [];
  const chips = cardLabels
    .map(
      (label) => `<span class="chip" style="--chip:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`
    )
    .join('');
  const menuOpen = openCardMenuId === card.id;
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      ${chips ? `<div class="chips">${chips}</div>` : ''}
      <div class="card-body">${escapeHtml(card.text)}</div>
      <div class="card-footer">
        <button type="button" class="label-toggle" data-card-id="${escapeHtml(card.id)}">${menuOpen ? '✕' : '🏷 Labels'}</button>
      </div>
      ${menuOpen ? renderCardLabelMenu(card) : ''}
    </article>
  `;
}

function renderCardLabelMenu(card) {
  const assigned = new Set((card.labels || []).map((label) => label.id));
  if (labels.length === 0) {
    return '<div class="card-label-menu"><em>No labels. Create some via “Manage labels”.</em></div>';
  }
  return `
    <div class="card-label-menu">
      ${labels
        .map((label) => {
          const isOn = assigned.has(label.id);
          return `<label class="menu-item">
            <input type="checkbox" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}" ${isOn ? 'checked' : ''} />
            <span class="dot" style="--chip:${escapeHtml(label.color)}"></span>${escapeHtml(label.name)}
          </label>`;
        })
        .join('')}
    </div>
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

  bindLabelEvents();

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

function bindLabelEvents() {
  const manageBtn = document.querySelector('#manage-labels');
  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      labelManagerOpen = true;
      render();
    });
  }

  const closeBtn = document.querySelector('#close-label-modal');
  if (closeBtn) closeBtn.addEventListener('click', closeLabelManager);
  const backdrop = document.querySelector('#label-modal-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) closeLabelManager();
    });
  }

  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.filterId;
      if (activeFilter.has(id)) activeFilter.delete(id);
      else activeFilter.add(id);
      render();
    });
  });

  const clearBtn = document.querySelector('#clear-filter');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilter.clear();
      render();
    });
  }

  const createForm = document.querySelector('#label-create-form');
  if (createForm) {
    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
      if (!name) return;
      await createLabel(name, color);
    });
  }

  document.querySelectorAll('.label-row').forEach((row) => {
    const id = row.dataset.labelId;
    row.querySelector('[data-action="save"]')?.addEventListener('click', async () => {
      const name = row.querySelector('.label-name-input').value.trim();
      const color = row.querySelector('.label-color-input').value;
      if (!name) {
        setStatus('Label name cannot be empty', true);
        return;
      }
      await updateLabel(id, name, color);
    });
    row.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
      await deleteLabel(id);
    });
  });

  document.querySelectorAll('.label-toggle').forEach((btn) => {
    btn.addEventListener('mousedown', (event) => event.stopPropagation());
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = btn.dataset.cardId;
      openCardMenuId = openCardMenuId === id ? null : id;
      render();
    });
  });

  document.querySelectorAll('.card-label-menu').forEach((menu) => {
    menu.addEventListener('mousedown', (event) => event.stopPropagation());
  });

  document.querySelectorAll('.card-label-menu input[type="checkbox"]').forEach((box) => {
    box.addEventListener('change', async () => {
      const cardId = box.dataset.cardId;
      const labelId = box.dataset.labelId;
      if (box.checked) await assignLabel(cardId, labelId);
      else await unassignLabel(cardId, labelId);
    });
  });
}

function closeLabelManager() {
  labelManagerOpen = false;
  render();
}

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
    const created = await response.json();
    upsertLabel(created);
    render();
  } catch (error) {
    setStatus(`Label create failed: ${error.message}`, true);
  }
}

async function updateLabel(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update failed');
    const updated = await response.json();
    upsertLabel(updated);
    applyLabelToBoard(updated);
    render();
  } catch (error) {
    setStatus(`Label update failed: ${error.message}`, true);
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 204) {
      throw new Error((await response.json()).error || 'Delete failed');
    }
    removeLabelLocally(id);
    render();
  } catch (error) {
    setStatus(`Label delete failed: ${error.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Assign failed');
    const card = await response.json();
    updateCardLabels(card);
    render();
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(
      `${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`,
      { method: 'DELETE' }
    );
    if (!response.ok) throw new Error((await response.json()).error || 'Unassign failed');
    const card = await response.json();
    updateCardLabels(card);
    render();
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
  }
}

function upsertLabel(label) {
  const index = labels.findIndex((l) => l.id === label.id);
  if (index === -1) labels.push(label);
  else labels[index] = label;
  labels.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function applyLabelToBoard(label) {
  for (const column of board.columns) {
    for (const card of column.cards) {
      if (!card.labels) continue;
      card.labels = card.labels.map((l) => (l.id === label.id ? { ...label } : l));
    }
  }
}

function removeLabelLocally(id) {
  labels = labels.filter((l) => l.id !== id);
  activeFilter.delete(id);
  for (const column of board.columns) {
    for (const card of column.cards) {
      if (card.labels) card.labels = card.labels.filter((l) => l.id !== id);
    }
  }
}

function updateCardLabels(card) {
  const found = findCard(card.id);
  if (found) found.card.labels = card.labels || [];
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
  switch (message.type) {
    case 'label-create':
    case 'label-update':
      upsertLabel(message.label);
      applyLabelToBoard(message.label);
      render();
      setStatus('Synced');
      return;
    case 'label-delete':
      removeLabelLocally(message.labelId);
      render();
      setStatus('Synced');
      return;
    case 'label-assign':
    case 'label-unassign':
      if (message.card) {
        updateCardLabels(message.card);
        render();
        setStatus('Synced');
      }
      return;
    default:
      break;
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
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
  render();
}

async function loadLabels() {
  const response = await fetch(`${API_BASE}/api/labels`);
  if (!response.ok) throw new Error('Could not load labels');
  labels = await response.json();
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
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
