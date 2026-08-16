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
        .map((card) => ({ ...card, labels: [...(card.labels || [])].sort(compareLabels) }))
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  return { columns };
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function compareLabels(a, b) {
  return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
}

function cardMatchesFilter(card) {
  if (selectedLabelIds.size === 0) return true;
  return (card.labels || []).some((label) => selectedLabelIds.has(label.id));
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
    <section class="labels-panel">
      <div class="filter-bar">
        <div>
          <h2>Filter by labels</h2>
          <p>Select one or more labels to show matching cards only.</p>
        </div>
        <div class="filter-options">
          ${labels.length ? labels.map(renderFilterOption).join('') : '<span class="muted">No labels yet</span>'}
          ${selectedLabelIds.size ? '<button type="button" class="clear-filters">Clear filters</button>' : ''}
          ${selectedLabelIds.size ? '<span class="filter-note">Showing matching cards only</span>' : ''}
        </div>
      </div>
      <details class="label-manager">
        <summary>Manage labels</summary>
        <form class="create-label">
          <input name="name" type="text" maxlength="80" placeholder="New label name" autocomplete="off" />
          <input name="color" type="color" value="#2563EB" title="Label color" />
          <button type="submit">Create label</button>
        </form>
        <div class="label-list">
          ${labels.length ? labels.map(renderLabelEditor).join('') : '<p class="muted">Create labels to tag cards and filter the board.</p>'}
        </div>
      </details>
    </section>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderFilterOption(label) {
  const checked = selectedLabelIds.has(label.id) ? 'checked' : '';
  return `
    <label class="filter-chip" style="--label-color: ${escapeHtml(label.color)}">
      <input type="checkbox" class="label-filter" value="${escapeHtml(label.id)}" ${checked} />
      <span>${escapeHtml(label.name)}</span>
    </label>
  `;
}

function renderLabelEditor(label) {
  return `
    <form class="label-editor" data-label-id="${escapeHtml(label.id)}">
      <span class="label-color-dot" style="background: ${escapeHtml(label.color)}"></span>
      <input name="name" type="text" maxlength="80" value="${escapeHtml(label.name)}" />
      <input name="color" type="color" value="${escapeHtml(label.color)}" />
      <button type="submit">Save</button>
      <button type="button" class="delete-label" data-label-id="${escapeHtml(label.id)}">Delete</button>
    </form>
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
  const cardLabelIds = new Set((card.labels || []).map((label) => label.id));
  const assignable = labels.filter((label) => !cardLabelIds.has(label.id));
  const assignText = labels.length ? 'All labels assigned' : 'No labels available';
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-labels">
        ${(card.labels || []).length ? card.labels.map((label) => renderCardLabel(label, card.id)).join('') : '<span class="no-labels">No labels</span>'}
      </div>
      <div class="card-label-actions">
        <select class="assign-label-select" data-card-id="${escapeHtml(card.id)}" ${assignable.length ? '' : 'disabled'}>
          <option value="">${assignable.length ? 'Add label…' : assignText}</option>
          ${assignable.map((label) => `<option value="${escapeHtml(label.id)}">${escapeHtml(label.name)}</option>`).join('')}
        </select>
      </div>
    </article>
  `;
}

function renderCardLabel(label, cardId) {
  return `
    <span class="label-chip" style="--label-color: ${escapeHtml(label.color)}">
      ${escapeHtml(label.name)}
      <button type="button" class="remove-card-label" data-card-id="${escapeHtml(cardId)}" data-label-id="${escapeHtml(label.id)}" aria-label="Remove ${escapeHtml(label.name)}">×</button>
    </span>
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

  document.querySelectorAll('.create-label').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = form.elements.name.value.trim();
      const color = form.elements.color.value;
      if (!name) return setStatus('Label name is required', true);
      form.elements.name.value = '';
      await createLabel(name, color);
    });
  });

  document.querySelectorAll('.label-editor').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await updateLabel(form.dataset.labelId, form.elements.name.value.trim(), form.elements.color.value);
    });
  });

  document.querySelectorAll('.delete-label').forEach((button) => {
    button.addEventListener('click', async () => {
      await deleteLabel(button.dataset.labelId);
    });
  });

  document.querySelectorAll('.label-filter').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedLabelIds.add(checkbox.value);
      else selectedLabelIds.delete(checkbox.value);
      render();
    });
  });

  document.querySelectorAll('.clear-filters').forEach((button) => {
    button.addEventListener('click', () => {
      selectedLabelIds.clear();
      render();
    });
  });

  document.querySelectorAll('.assign-label-select').forEach((select) => {
    select.addEventListener('mousedown', (event) => event.stopPropagation());
    select.addEventListener('change', async () => {
      const labelId = select.value;
      select.value = '';
      if (labelId) await assignLabel(select.dataset.cardId, labelId);
    });
  });

  document.querySelectorAll('.remove-card-label').forEach((button) => {
    button.addEventListener('mousedown', (event) => event.stopPropagation());
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      await unassignLabel(button.dataset.cardId, button.dataset.labelId);
    });
  });

  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      if (event.target.closest('button, input, select, textarea, form')) {
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
      if (!draggedCardId) return;
      event.preventDefault();
      const afterElement = getDragAfterElement(list, event.clientY);
      const dragging = document.querySelector(`[data-card-id="${CSS.escape(draggedCardId)}"]`);
      if (!dragging) return;
      list.classList.add('drop-target');
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
      const { beforeId, afterId } = neighborsFor(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
      await moveCard(cardId, columnId, beforeId, afterId);
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

function neighborsFor(list, cardId) {
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

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) {
    let message = 'Request failed';
    try {
      message = (await response.json()).error || message;
    } catch {
      // ignore non-json error bodies
    }
    throw new Error(message);
  }
  return response.json();
}

async function createCard(columnId, text) {
  try {
    await request('/api/cards', {
      method: 'POST',
      body: JSON.stringify({ columnId, text }),
    });
  } catch (error) {
    setStatus(`Create failed: ${error.message}`, true);
  }
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  try {
    await request(`/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
  } catch (error) {
    setStatus(`Move failed: ${error.message}`, true);
    await loadBoard();
  }
}

async function createLabel(name, color) {
  try {
    await request('/api/labels', { method: 'POST', body: JSON.stringify({ name, color }) });
  } catch (error) {
    setStatus(`Create label failed: ${error.message}`, true);
  }
}

async function updateLabel(labelId, name, color) {
  try {
    await request(`/api/labels/${encodeURIComponent(labelId)}`, { method: 'PUT', body: JSON.stringify({ name, color }) });
  } catch (error) {
    setStatus(`Save label failed: ${error.message}`, true);
  }
}

async function deleteLabel(labelId) {
  try {
    await request(`/api/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
    selectedLabelIds.delete(labelId);
  } catch (error) {
    setStatus(`Delete label failed: ${error.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    await request(`/api/cards/${encodeURIComponent(cardId)}/labels`, { method: 'POST', body: JSON.stringify({ labelId }) });
  } catch (error) {
    setStatus(`Assign label failed: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    await request(`/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
  } catch (error) {
    setStatus(`Remove label failed: ${error.message}`, true);
  }
}

function applyMutation(message) {
  if (message.labels) {
    labels = [...message.labels].sort(compareLabels);
    const validIds = new Set(labels.map((label) => label.id));
    selectedLabelIds = new Set([...selectedLabelIds].filter((id) => validIds.has(id)));
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
  labels = (await request('/api/labels')).sort(compareLabels);
}

async function loadBoard() {
  const nextBoard = await request('/api/board');
  board = normalizeBoard(nextBoard);
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
    await Promise.all([loadLabels(), loadBoard()]);
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
