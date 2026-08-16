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

function escapeAttr(value) {
  return escapeHtml(value);
}

function normalizeColor(color) {
  return /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : '#64748b';
}

function chipTextColor(color) {
  const hex = normalizeColor(color).slice(1);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#172033' : '#ffffff';
}

function sortLabels(items) {
  return [...(items || [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id));
}

function cardMatchesFilter(card) {
  if (selectedLabelIds.size === 0) return true;
  return (card.labels || []).some((label) => selectedLabelIds.has(label.id));
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
        .map((card) => ({ ...card, labels: sortLabels(card.labels || []) }))
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
  selectedLabelIds = new Set([...selectedLabelIds].filter((id) => labels.some((label) => label.id === id)));
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
          <h2>Filter by label</h2>
          <p>Select one or more labels to show matching cards only on this client.</p>
        </div>
        <div class="filter-options">
          ${labels.length ? labels.map(renderFilterOption).join('') : '<span class="muted">No labels yet.</span>'}
          ${selectedLabelIds.size ? '<button type="button" class="clear-filter">Clear filter</button>' : ''}
        </div>
      </div>
      <details class="label-manager">
        <summary>Manage labels</summary>
        <form class="create-label">
          <input name="name" type="text" maxlength="100" placeholder="Label name" autocomplete="off" required />
          <input name="color" type="color" value="#2563eb" aria-label="Label color" />
          <button type="submit">Create label</button>
        </form>
        <div class="label-list">
          ${labels.map(renderLabelManagerRow).join('') || '<p class="muted">Create labels to tag cards and filter the board.</p>'}
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
  const color = normalizeColor(label.color);
  return `
    <label class="filter-chip" style="--label-color:${escapeAttr(color)}">
      <input type="checkbox" class="filter-label" data-label-id="${escapeAttr(label.id)}" ${checked} />
      <span>${escapeHtml(label.name)}</span>
    </label>
  `;
}

function renderLabelManagerRow(label) {
  return `
    <form class="edit-label" data-label-id="${escapeAttr(label.id)}">
      <span class="label-swatch" style="background:${escapeAttr(normalizeColor(label.color))}"></span>
      <input name="name" type="text" maxlength="100" value="${escapeAttr(label.name)}" required />
      <input name="color" type="color" value="${escapeAttr(normalizeColor(label.color))}" aria-label="${escapeAttr(label.name)} color" />
      <button type="submit">Save</button>
      <button type="button" class="delete-label" data-label-id="${escapeAttr(label.id)}">Delete</button>
    </form>
  `;
}

function renderColumn(column) {
  return `
    <section class="column" data-column-id="${escapeAttr(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeAttr(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeAttr(column.id)}">
        ${column.cards.filter(cardMatchesFilter).map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const assignedIds = new Set((card.labels || []).map((label) => label.id));
  const available = labels.filter((label) => !assignedIds.has(label.id));
  return `
    <article class="card" draggable="true" data-card-id="${escapeAttr(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${(card.labels || []).length ? `<div class="card-labels">${(card.labels || []).map((label) => renderCardLabel(card, label)).join('')}</div>` : ''}
      <div class="card-label-controls">
        <select class="assign-label" data-card-id="${escapeAttr(card.id)}" aria-label="Add label to card" ${available.length ? '' : 'disabled'}>
          <option value="">${available.length ? 'Add label…' : 'No labels to add'}</option>
          ${available.map((label) => `<option value="${escapeAttr(label.id)}">${escapeHtml(label.name)}</option>`).join('')}
        </select>
      </div>
    </article>
  `;
}

function renderCardLabel(card, label) {
  const color = normalizeColor(label.color);
  const textColor = chipTextColor(color);
  return `
    <span class="label-chip" style="background:${escapeAttr(color)};color:${escapeAttr(textColor)}">
      ${escapeHtml(label.name)}
      <button type="button" class="remove-card-label" data-card-id="${escapeAttr(card.id)}" data-label-id="${escapeAttr(label.id)}" aria-label="Remove ${escapeAttr(label.name)}">×</button>
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

  document.querySelector('.create-label')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return;
    const created = await apiRequest('/api/labels', { method: 'POST', body: { name, color } }, 'Create label failed');
    if (created) {
      form.reset();
      form.elements.color.value = '#2563eb';
    }
  });

  document.querySelectorAll('.edit-label').forEach((form) => {
    form.querySelectorAll('input').forEach((input) => {
      input.addEventListener('click', (event) => event.stopPropagation());
      input.addEventListener('mousedown', (event) => event.stopPropagation());
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = form.elements.name.value.trim();
      const color = form.elements.color.value;
      if (!name) return;
      await apiRequest(`/api/labels/${encodeURIComponent(form.dataset.labelId)}`, { method: 'PUT', body: { name, color } }, 'Update label failed');
    });
  });

  document.querySelectorAll('.delete-label').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      await apiRequest(`/api/labels/${encodeURIComponent(button.dataset.labelId)}`, { method: 'DELETE' }, 'Delete label failed');
    });
  });

  document.querySelectorAll('.filter-label').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedLabelIds.add(checkbox.dataset.labelId);
      else selectedLabelIds.delete(checkbox.dataset.labelId);
      render();
      setStatus('Filtered');
    });
  });

  document.querySelector('.clear-filter')?.addEventListener('click', () => {
    selectedLabelIds.clear();
    render();
    setStatus('Live');
  });

  document.querySelectorAll('.assign-label').forEach((select) => {
    select.addEventListener('click', (event) => event.stopPropagation());
    select.addEventListener('mousedown', (event) => event.stopPropagation());
    select.addEventListener('change', async () => {
      const labelId = select.value;
      if (!labelId) return;
      await apiRequest(`/api/cards/${encodeURIComponent(select.dataset.cardId)}/labels`, {
        method: 'POST',
        body: { labelId },
      }, 'Assign label failed');
    });
  });

  document.querySelectorAll('.remove-card-label').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      await apiRequest(
        `/api/cards/${encodeURIComponent(button.dataset.cardId)}/labels/${encodeURIComponent(button.dataset.labelId)}`,
        { method: 'DELETE' },
        'Remove label failed'
      );
    });
  });

  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', (event) => {
      if (event.target.closest('button, input, select, textarea')) {
        event.preventDefault();
        return;
      }
      draggedCardId = card.dataset.cardId;
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      draggedCardId = null;
      document.querySelectorAll('.cards').forEach((list) => list.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      list.classList.add('drop-target');
      const dragging = document.querySelector('.card.dragging');
      if (!dragging) return;
      const after = getCardAfterPointer(list, event.clientY);
      if (after == null) list.appendChild(dragging);
      else list.insertBefore(dragging, after);
    });
    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      const cardId = event.dataTransfer.getData('text/plain') || draggedCardId;
      if (!cardId) return;
      const columnId = list.dataset.columnId;
      const { beforeId, afterId } = getDropNeighbors(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
      try {
        const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/move`, {
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
}

function getCardAfterPointer(list, y) {
  const cards = [...list.querySelectorAll('.card:not(.dragging)')];
  return cards.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function getDropNeighbors(list, cardId) {
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
  await apiRequest('/api/cards', { method: 'POST', body: { columnId, text } }, 'Create failed');
}

async function apiRequest(path, options = {}, errorPrefix = 'Request failed') {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!response.ok) {
      let message = errorPrefix;
      try {
        message = (await response.json()).error || message;
      } catch {
        // ignore non-json error bodies
      }
      throw new Error(message);
    }
    const isJson = response.headers.get('content-type')?.includes('application/json');
    const data = isJson ? await response.json() : null;
    setStatus('Synced');
    const method = (options.method || 'GET').toUpperCase();
    if (method !== 'POST' || path.includes('/labels')) {
      try {
        await refreshBoardState();
      } catch (refreshError) {
        setStatus(`Refresh failed: ${refreshError.message}`, true);
      }
    }
    return data;
  } catch (error) {
    setStatus(`${errorPrefix}: ${error.message}`, true);
    return null;
  }
}

function applyMutation(message) {
  if (message.labels) labels = sortLabels(message.labels);

  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (!message.card) return;
  const card = { ...message.card, labels: sortLabels(message.card.labels || []) };
  removeCardEverywhere(card.id);
  const target = board.columns.find((column) => column.id === card.column_id || column.id === message.columnId);
  if (!target) return;
  target.cards.push(card);
  target.cards.sort(compareCards);
  render();
  setStatus('Synced');
}

async function refreshBoardState() {
  const [boardResponse, labelsResponse] = await Promise.all([
    fetch(`${API_BASE}/api/board`),
    fetch(`${API_BASE}/api/labels`),
  ]);
  if (!boardResponse.ok) throw new Error('Could not load board');
  if (!labelsResponse.ok) throw new Error('Could not load labels');
  board = normalizeBoard(await boardResponse.json());
  labels = sortLabels(await labelsResponse.json());
  render();
}

async function loadBoard() {
  await refreshBoardState();
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
