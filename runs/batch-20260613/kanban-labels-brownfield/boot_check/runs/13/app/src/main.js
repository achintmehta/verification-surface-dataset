import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [], labels: [] };
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let selectedLabelIds = new Set();
let openLabelMenuCardId = null;
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
        .map((card) => ({ ...card, labels: [...(card.labels || [])] }))
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  const labels = [...(nextBoard.labels || [])].sort(
    (a, b) => String(a.name).localeCompare(String(b.name)) || a.id.localeCompare(b.id)
  );
  return { columns, labels };
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function cardMatchesFilter(card) {
  if (selectedLabelIds.size === 0) return true;
  return (card.labels || []).some((label) => selectedLabelIds.has(label.id));
}

function render() {
  const labels = board.labels || [];
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <section class="toolbar">
      <div class="filter-bar">
        <span class="toolbar-label">Filter:</span>
        ${
          labels.length === 0
            ? '<span class="filter-empty">No labels yet</span>'
            : labels
                .map(
                  (label) => `
          <button type="button" class="filter-chip${selectedLabelIds.has(label.id) ? ' active' : ''}"
            data-filter-label-id="${escapeHtml(label.id)}"
            style="--chip-color: ${escapeHtml(label.color)}">
            <span class="chip-dot" style="background:${escapeHtml(label.color)}"></span>
            ${escapeHtml(label.name)}
          </button>`
                )
                .join('')
        }
        ${
          selectedLabelIds.size > 0
            ? '<button type="button" class="filter-clear" id="clear-filter">Clear filter</button>'
            : ''
        }
      </div>
      <button type="button" class="manage-labels-btn" id="toggle-label-manager">
        ${labelManagerOpen ? 'Close labels' : 'Manage labels'}
      </button>
    </section>
    ${labelManagerOpen ? renderLabelManager() : ''}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
  bindLabelEvents();
}

function bindLabelEvents() {
  // Filter chips
  document.querySelectorAll('[data-filter-label-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.filterLabelId;
      if (selectedLabelIds.has(id)) selectedLabelIds.delete(id);
      else selectedLabelIds.add(id);
      render();
    });
  });
  document.querySelector('#clear-filter')?.addEventListener('click', () => {
    selectedLabelIds.clear();
    render();
  });

  // Label manager toggle
  document.querySelector('#toggle-label-manager')?.addEventListener('click', () => {
    labelManagerOpen = !labelManagerOpen;
    render();
  });

  // Create label
  document.querySelector('#label-create-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value;
    const color = form.elements.color.value;
    await createLabel(name, color);
    if (form.elements.name) form.elements.name.value = '';
  });

  // Save (rename / recolor)
  document.querySelectorAll('.label-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.labelId;
      const row = document.querySelector(`[data-label-row-id="${cssEscape(id)}"]`);
      if (!row) return;
      const name = row.querySelector('.label-name-input')?.value;
      const color = row.querySelector('.label-color-input')?.value;
      await updateLabel(id, name, color);
    });
  });

  // Delete label
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteLabel(btn.dataset.labelId);
    });
  });

  // Card: toggle label menu
  document.querySelectorAll('.card-label-toggle').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = btn.dataset.cardId;
      openLabelMenuCardId = openLabelMenuCardId === id ? null : id;
      render();
    });
  });

  // Card: assign/unassign via checkbox
  document.querySelectorAll('[data-assign-label-id]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const cardId = checkbox.dataset.assignCardId;
      const labelId = checkbox.dataset.assignLabelId;
      if (checkbox.checked) await assignLabel(cardId, labelId);
      else await unassignLabel(cardId, labelId);
    });
  });

  // Card: remove chip
  document.querySelectorAll('.chip-remove').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await unassignLabel(btn.dataset.cardId, btn.dataset.labelId);
    });
  });

  // Prevent label controls from triggering card drag
  document
    .querySelectorAll('.label-menu, .card-actions, .chip-remove, .label-menu-item')
    .forEach((el) => {
      el.addEventListener('mousedown', (event) => event.stopPropagation());
      el.setAttribute('draggable', 'false');
    });
}

function cssEscape(value) {
  return String(value).replace(/"/g, '\\"');
}

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
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
  } catch (error) {
    setStatus(`Label update failed: ${error.message}`, true);
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Delete failed');
    selectedLabelIds.delete(id);
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
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
  }
}

function renderLabelManager() {
  const labels = board.labels || [];
  return `
    <section class="label-manager">
      <h3>Labels</h3>
      <ul class="label-list">
        ${labels
          .map(
            (label) => `
          <li class="label-row" data-label-row-id="${escapeHtml(label.id)}">
            <input type="color" class="label-color-input" data-label-id="${escapeHtml(label.id)}" value="${escapeHtml(
              label.color
            )}" />
            <input type="text" class="label-name-input" data-label-id="${escapeHtml(label.id)}" value="${escapeHtml(
              label.name
            )}" maxlength="100" />
            <button type="button" class="label-save-btn" data-label-id="${escapeHtml(label.id)}">Save</button>
            <button type="button" class="label-delete-btn" data-label-id="${escapeHtml(label.id)}">Delete</button>
          </li>`
          )
          .join('')}
      </ul>
      <form class="label-create" id="label-create-form">
        <input type="color" name="color" value="#2563eb" />
        <input type="text" name="name" placeholder="New label name…" maxlength="100" autocomplete="off" />
        <button type="submit">Create label</button>
      </form>
    </section>
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
        ${column.cards.filter(cardMatchesFilter).map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const cardLabels = card.labels || [];
  const assignedIds = new Set(cardLabels.map((l) => l.id));
  const allLabels = board.labels || [];
  const menuOpen = openLabelMenuCardId === card.id;
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${
        cardLabels.length > 0
          ? `<div class="card-labels">${cardLabels
              .map(
                (label) => `
        <span class="chip" style="background:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">
          ${escapeHtml(label.name)}
          <button type="button" class="chip-remove" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(
                  label.id
                )}" title="Remove label">×</button>
        </span>`
              )
              .join('')}</div>`
          : ''
      }
      <div class="card-actions">
        <button type="button" class="card-label-toggle" data-card-id="${escapeHtml(card.id)}">＋ Labels</button>
      </div>
      ${
        menuOpen
          ? `<div class="label-menu" data-card-id="${escapeHtml(card.id)}">
              ${
                allLabels.length === 0
                  ? '<div class="label-menu-empty">No labels. Create one via “Manage labels”.</div>'
                  : allLabels
                      .map(
                        (label) => `
              <label class="label-menu-item">
                <input type="checkbox" data-assign-card-id="${escapeHtml(card.id)}" data-assign-label-id="${escapeHtml(
                          label.id
                        )}" ${assignedIds.has(label.id) ? 'checked' : ''} />
                <span class="chip-dot" style="background:${escapeHtml(label.color)}"></span>
                ${escapeHtml(label.name)}
              </label>`
                      )
                      .join('')
              }
            </div>`
          : ''
      }
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
