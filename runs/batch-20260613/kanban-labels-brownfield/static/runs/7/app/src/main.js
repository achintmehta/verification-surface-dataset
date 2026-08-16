import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedFilterIds = new Set();
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
        .map((card) => ({ ...card, labels: [...(card.labels || [])].sort(compareLabels) }))
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

function normalizeLabels(nextLabels) {
  return [...(nextLabels || [])].sort(compareLabels);
}

function compareLabels(a, b) {
  return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }) || String(a.name).localeCompare(String(b.name)) || a.id.localeCompare(b.id);
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function cardMatchesFilter(card) {
  if (selectedFilterIds.size === 0) return true;
  return (card.labels || []).some((label) => selectedFilterIds.has(label.id));
}

function render() {
  selectedFilterIds = new Set([...selectedFilterIds].filter((id) => labels.some((label) => label.id === id)));
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <section class="labels-panel">
      <div class="label-section">
        <h2>Filter by label</h2>
        <div class="filter-labels">
          ${labels.length === 0 ? '<span class="muted">No labels yet.</span>' : labels.map(renderFilterOption).join('')}
          ${selectedFilterIds.size ? '<button class="small ghost" type="button" id="clear-filters">Clear</button>' : ''}
        </div>
      </div>
      <div class="label-section">
        <h2>Manage labels</h2>
        <form class="label-create">
          <input name="name" type="text" maxlength="100" placeholder="New label" autocomplete="off" />
          <input name="color" type="color" value="#2563eb" title="Label color" />
          <button type="submit">Create</button>
        </form>
        <div class="label-list">
          ${labels.map(renderLabelEditor).join('') || '<span class="muted">Create a label to tag cards.</span>'}
        </div>
      </div>
    </section>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderFilterOption(label) {
  const checked = selectedFilterIds.has(label.id) ? 'checked' : '';
  return `
    <label class="filter-chip" style="--label-color: ${escapeHtml(label.color)}">
      <input type="checkbox" class="filter-toggle" value="${escapeHtml(label.id)}" ${checked} />
      <span>${escapeHtml(label.name)}</span>
    </label>
  `;
}

function renderLabelEditor(label) {
  return `
    <form class="label-edit" data-label-id="${escapeHtml(label.id)}">
      <input name="name" type="text" maxlength="100" value="${escapeHtml(label.name)}" />
      <input name="color" type="color" value="${escapeHtml(label.color)}" />
      <button type="submit">Save</button>
      <button type="button" class="danger delete-label">Delete</button>
    </form>
  `;
}

function renderColumn(column) {
  const cards = column.cards.filter(cardMatchesFilter);
  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${cards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const assignedIds = new Set((card.labels || []).map((label) => label.id));
  const available = labels.filter((label) => !assignedIds.has(label.id));
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-labels">
        ${(card.labels || []).map((label) => renderCardLabel(card.id, label)).join('')}
      </div>
      <form class="assign-label" data-card-id="${escapeHtml(card.id)}">
        <select name="labelId" ${available.length === 0 ? 'disabled' : ''}>
          <option value="">${labels.length === 0 ? 'No labels' : 'Add label…'}</option>
          ${available.map((label) => `<option value="${escapeHtml(label.id)}">${escapeHtml(label.name)}</option>`).join('')}
        </select>
        <button type="submit" ${available.length === 0 ? 'disabled' : ''}>Add</button>
      </form>
    </article>
  `;
}

function renderCardLabel(cardId, label) {
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

  document.querySelectorAll('.label-create').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = form.elements.name.value.trim();
      const color = form.elements.color.value;
      if (!name) return setStatus('Label name is required', true);
      form.elements.name.value = '';
      await createLabel(name, color);
    });
  });

  document.querySelectorAll('.label-edit').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await updateLabel(form.dataset.labelId, form.elements.name.value.trim(), form.elements.color.value);
    });
    form.querySelector('.delete-label')?.addEventListener('click', async () => {
      if (confirm('Delete this label and remove it from all cards?')) await deleteLabel(form.dataset.labelId);
    });
  });

  document.querySelectorAll('.filter-toggle').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) selectedFilterIds.add(input.value);
      else selectedFilterIds.delete(input.value);
      render();
      setStatus('Filter updated');
    });
  });
  document.querySelector('#clear-filters')?.addEventListener('click', () => {
    selectedFilterIds.clear();
    render();
    setStatus('Filter cleared');
  });

  document.querySelectorAll('.assign-label').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const labelId = form.elements.labelId.value;
      if (labelId) await assignLabel(form.dataset.cardId, labelId);
    });
  });

  document.querySelectorAll('.remove-card-label').forEach((button) => {
    button.addEventListener('click', async () => {
      await unassignLabel(button.dataset.cardId, button.dataset.labelId);
    });
  });

  document.querySelectorAll('.card input, .card select, .card button').forEach((control) => {
    control.addEventListener('mousedown', (event) => event.stopPropagation());
    control.addEventListener('dragstart', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  });

  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', (event) => {
      draggedCardId = card.dataset.cardId;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      draggedCardId = null;
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      const after = getDragAfterElement(list, event.clientY);
      const dragging = document.querySelector('.card.dragging');
      if (!dragging) return;
      list.classList.add('drop-target');
      if (after == null) list.appendChild(dragging);
      else list.insertBefore(dragging, after);
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
  const elements = [...container.querySelectorAll('.card:not(.dragging)')];
  return elements.reduce(
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
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    let message = 'Request failed';
    try {
      message = (await response.json()).error || message;
    } catch {
      // ignore non-json error bodies
    }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function createCard(columnId, text) {
  try {
    await request('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
  } catch (error) {
    setStatus(`Move failed: ${error.message}`, true);
    await loadBoard();
  }
}

async function createLabel(name, color) {
  try {
    await request('/api/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
  } catch (error) {
    setStatus(`Label create failed: ${error.message}`, true);
  }
}

async function updateLabel(labelId, name, color) {
  try {
    if (!name) throw new Error('Label name is required');
    await request(`/api/labels/${encodeURIComponent(labelId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
  } catch (error) {
    setStatus(`Label update failed: ${error.message}`, true);
  }
}

async function deleteLabel(labelId) {
  try {
    await request(`/api/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
  } catch (error) {
    setStatus(`Label delete failed: ${error.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    await request(`/api/cards/${encodeURIComponent(cardId)}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
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
  if (message.labels) labels = normalizeLabels(message.labels);
  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (!message.card) return;
  const card = { ...message.card, labels: [...(message.card.labels || [])].sort(compareLabels) };
  removeCardEverywhere(card.id);
  const target = board.columns.find((column) => column.id === card.column_id || column.id === message.columnId);
  if (!target) return;
  target.cards.push(card);
  target.cards.sort(compareCards);
  render();
  setStatus('Synced');
}

async function loadBoard() {
  const [boardResponse, labelsResponse] = await Promise.all([
    fetch(`${API_BASE}/api/board`),
    fetch(`${API_BASE}/api/labels`),
  ]);
  if (!boardResponse.ok) throw new Error('Could not load board');
  if (!labelsResponse.ok) throw new Error('Could not load labels');
  board = normalizeBoard(await boardResponse.json());
  labels = normalizeLabels(await labelsResponse.json());
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
