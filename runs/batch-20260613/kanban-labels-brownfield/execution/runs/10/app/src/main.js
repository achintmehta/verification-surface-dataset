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

function normalizeLabels(nextLabels) {
  labels = [...(nextLabels || [])].sort(compareLabels);
  const existing = new Set(labels.map((label) => label.id));
  selectedLabelIds = new Set([...selectedLabelIds].filter((id) => existing.has(id)));
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
        <h2>Filter by labels</h2>
        <div class="filter-options">
          ${labels.length ? labels.map(renderFilterOption).join('') : '<span class="muted">No labels yet.</span>'}
        </div>
        ${selectedLabelIds.size ? '<button type="button" class="clear-filter">Clear filter</button>' : ''}
      </div>
      <div class="label-manager">
        <h2>Labels</h2>
        <form class="create-label">
          <input name="name" type="text" maxlength="80" placeholder="New label name" autocomplete="off" />
          <input name="color" type="color" value="#2563EB" aria-label="Label color" />
          <button type="submit">Create</button>
        </form>
        <div class="label-list">
          ${labels.length ? labels.map(renderManagedLabel).join('') : '<span class="muted">Create a label to tag cards.</span>'}
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
  const checked = selectedLabelIds.has(label.id) ? 'checked' : '';
  return `
    <label class="filter-chip" style="--label-color:${escapeAttr(label.color)}">
      <input type="checkbox" class="filter-label" value="${escapeAttr(label.id)}" ${checked} />
      <span>${escapeHtml(label.name)}</span>
    </label>
  `;
}

function renderManagedLabel(label) {
  return `
    <div class="managed-label" data-label-id="${escapeAttr(label.id)}">
      <span class="label-chip" style="--label-color:${escapeAttr(label.color)}">${escapeHtml(label.name)}</span>
      <button type="button" class="rename-label">Rename</button>
      <input class="recolor-label" type="color" value="${escapeAttr(label.color)}" aria-label="Change ${escapeAttr(label.name)} color" />
      <button type="button" class="delete-label">Delete</button>
    </div>
  `;
}

function renderColumn(column) {
  const visibleCards = column.cards.filter(cardMatchesFilter);
  return `
    <section class="column" data-column-id="${escapeAttr(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeAttr(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeAttr(column.id)}">
        ${visibleCards.length ? visibleCards.map(renderCard).join('') : renderEmptyColumnMessage(column.cards.length)}
      </div>
    </section>
  `;
}

function renderEmptyColumnMessage(totalCards) {
  if (selectedLabelIds.size && totalCards) return '<div class="empty-column">No cards match the selected labels.</div>';
  return '';
}

function renderCard(card) {
  const assigned = new Set((card.labels || []).map((label) => label.id));
  const unassigned = labels.filter((label) => !assigned.has(label.id));
  return `
    <article class="card" draggable="true" data-card-id="${escapeAttr(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-labels">
        ${(card.labels || []).map((label) => renderCardLabel(card.id, label)).join('')}
      </div>
      <form class="assign-label" data-card-id="${escapeAttr(card.id)}">
        <select name="labelId" ${unassigned.length ? '' : 'disabled'} aria-label="Assign label">
          <option value="">${unassigned.length ? 'Add label…' : 'All labels assigned'}</option>
          ${unassigned.map((label) => `<option value="${escapeAttr(label.id)}">${escapeHtml(label.name)}</option>`).join('')}
        </select>
        <button type="submit" ${unassigned.length ? '' : 'disabled'}>Add</button>
      </form>
    </article>
  `;
}

function renderCardLabel(cardId, label) {
  return `
    <span class="label-chip card-chip" style="--label-color:${escapeAttr(label.color)}">
      ${escapeHtml(label.name)}
      <button type="button" class="remove-card-label" data-card-id="${escapeAttr(cardId)}" data-label-id="${escapeAttr(label.id)}" aria-label="Remove ${escapeAttr(label.name)}">×</button>
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

  const createLabelForm = document.querySelector('.create-label');
  createLabelForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = createLabelForm.elements.name.value.trim();
    const color = createLabelForm.elements.color.value;
    if (!name) return setStatus('Label name is required', true);
    createLabelForm.elements.name.value = '';
    await createLabel(name, color);
  });

  document.querySelectorAll('.filter-label').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) selectedLabelIds.add(input.value);
      else selectedLabelIds.delete(input.value);
      render();
    });
  });

  document.querySelector('.clear-filter')?.addEventListener('click', () => {
    selectedLabelIds.clear();
    render();
  });

  document.querySelectorAll('.managed-label').forEach((row) => {
    const label = labels.find((item) => item.id === row.dataset.labelId);
    row.querySelector('.rename-label')?.addEventListener('click', async () => {
      const name = window.prompt('Rename label', label?.name || '');
      if (name == null) return;
      await updateLabel(row.dataset.labelId, { name });
    });
    row.querySelector('.recolor-label')?.addEventListener('change', async (event) => {
      await updateLabel(row.dataset.labelId, { color: event.target.value });
    });
    row.querySelector('.delete-label')?.addEventListener('click', async () => {
      if (window.confirm(`Delete label "${label?.name || ''}" from all cards?`)) {
        await deleteLabel(row.dataset.labelId);
      }
    });
  });

  document.querySelectorAll('.assign-label').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const labelId = form.elements.labelId.value;
      if (!labelId) return;
      await assignLabel(form.dataset.cardId, labelId);
    });
  });

  document.querySelectorAll('.remove-card-label').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      await unassignLabel(button.dataset.cardId, button.dataset.labelId);
    });
  });

  document.querySelectorAll('.card button, .card select, .card input').forEach((control) => {
    control.addEventListener('mousedown', (event) => event.stopPropagation());
    control.addEventListener('dragstart', (event) => event.stopPropagation());
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
        await loadAll();
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

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error((await response.json()).error || 'Request failed');
  return response.status === 204 ? null : response.json();
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

async function createLabel(name, color) {
  try {
    const result = await request('/api/labels', {
      method: 'POST',
      body: JSON.stringify({ name, color }),
    });
    applyServerState(result);
    setStatus('Label created');
  } catch (error) {
    setStatus(`Label rejected: ${error.message}`, true);
  }
}

async function updateLabel(labelId, changes) {
  try {
    const result = await request(`/api/labels/${encodeURIComponent(labelId)}`, {
      method: 'PUT',
      body: JSON.stringify(changes),
    });
    applyServerState(result);
    setStatus('Label updated');
  } catch (error) {
    setStatus(`Label update failed: ${error.message}`, true);
  }
}

async function deleteLabel(labelId) {
  try {
    const result = await request(`/api/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
    selectedLabelIds.delete(labelId);
    applyServerState(result);
    setStatus('Label deleted');
  } catch (error) {
    setStatus(`Delete failed: ${error.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const result = await request(`/api/cards/${encodeURIComponent(cardId)}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labelId }),
    });
    applyServerState(result);
    setStatus('Label assigned');
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const result = await request(`/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
    applyServerState(result);
    setStatus('Label removed');
  } catch (error) {
    setStatus(`Remove failed: ${error.message}`, true);
  }
}

function applyServerState(message) {
  let changed = false;
  if (message?.labels) {
    normalizeLabels(message.labels);
    changed = true;
  }
  if (message?.board) {
    board = normalizeBoard(message.board);
    changed = true;
  }
  if (changed) render();
}

function applyMutation(message) {
  if (message.labels) normalizeLabels(message.labels);

  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (!message.card) {
    if (message.labels) render();
    return;
  }
  const card = { ...message.card, labels: message.card.labels || [] };
  removeCardEverywhere(card.id);
  const target = board.columns.find((column) => column.id === card.column_id || column.id === message.columnId);
  if (!target) return;
  target.cards.push(card);
  target.cards.sort(compareCards);
  render();
  setStatus('Synced');
}

async function loadAll() {
  const [boardResponse, labelsResponse] = await Promise.all([
    fetch(`${API_BASE}/api/board`),
    fetch(`${API_BASE}/api/labels`),
  ]);
  if (!boardResponse.ok) throw new Error('Could not load board');
  if (!labelsResponse.ok) throw new Error('Could not load labels');
  board = normalizeBoard(await boardResponse.json());
  normalizeLabels(await labelsResponse.json());
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
    await loadAll();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
