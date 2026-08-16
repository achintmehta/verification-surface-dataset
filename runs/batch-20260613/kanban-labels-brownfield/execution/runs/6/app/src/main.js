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

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function compareLabels(a, b) {
  return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
}

function visibleCards(cards) {
  if (selectedLabelIds.size === 0) return cards;
  return cards.filter((card) => (card.labels || []).some((label) => selectedLabelIds.has(label.id)));
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
    ${renderLabelPanel()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderLabelPanel() {
  return `
    <section class="label-panel">
      <div class="label-panel-section">
        <h2>Filter by labels</h2>
        <div class="filter-labels">
          ${labels.length === 0 ? '<span class="muted">No labels yet.</span>' : labels.map(renderFilterLabel).join('')}
          ${selectedLabelIds.size > 0 ? '<button type="button" class="clear-filter">Clear filter</button>' : ''}
        </div>
      </div>
      <div class="label-panel-section label-manager">
        <h2>Labels</h2>
        <form class="create-label">
          <input name="name" type="text" maxlength="80" placeholder="New label name" autocomplete="off" />
          <input name="color" type="color" value="#2563eb" aria-label="Label color" />
          <button type="submit">Create</button>
        </form>
        <div class="label-list">
          ${labels.map(renderLabelManagerRow).join('') || '<span class="muted">Create labels to tag cards.</span>'}
        </div>
      </div>
    </section>
  `;
}

function renderFilterLabel(label) {
  const checked = selectedLabelIds.has(label.id) ? 'checked' : '';
  return `
    <label class="filter-chip" style="--label-color: ${escapeAttr(label.color)}">
      <input type="checkbox" class="filter-label" value="${escapeAttr(label.id)}" ${checked} />
      <span>${escapeHtml(label.name)}</span>
    </label>
  `;
}

function renderLabelManagerRow(label) {
  return `
    <form class="edit-label" data-label-id="${escapeAttr(label.id)}">
      <input name="name" type="text" maxlength="80" value="${escapeAttr(label.name)}" aria-label="Label name" />
      <input name="color" type="color" value="${escapeAttr(label.color)}" aria-label="Label color" />
      <button type="submit">Save</button>
      <button type="button" class="delete-label">Delete</button>
    </form>
  `;
}

function renderColumn(column) {
  const cards = visibleCards(column.cards);
  return `
    <section class="column" data-column-id="${escapeAttr(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeAttr(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeAttr(column.id)}">
        ${cards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  return `
    <article class="card" draggable="true" data-card-id="${escapeAttr(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-labels">
        ${(card.labels || []).map(renderCardChip).join('')}
      </div>
      <div class="card-tools" draggable="false">
        ${renderCardLabelPicker(card)}
      </div>
    </article>
  `;
}

function renderCardChip(label) {
  return `<span class="label-chip" style="--label-color: ${escapeAttr(label.color)}">${escapeHtml(label.name)}</span>`;
}

function renderCardLabelPicker(card) {
  if (labels.length === 0) return '<span class="muted small">No labels available.</span>';
  const assigned = new Set((card.labels || []).map((label) => label.id));
  return `
    <details>
      <summary>Labels</summary>
      <div class="card-label-menu">
        ${labels.map((label) => `
          <label>
            <input type="checkbox" class="card-label-toggle" data-card-id="${escapeAttr(card.id)}" value="${escapeAttr(label.id)}" ${assigned.has(label.id) ? 'checked' : ''} />
            <span class="label-chip" style="--label-color: ${escapeAttr(label.color)}">${escapeHtml(label.name)}</span>
          </label>
        `).join('')}
      </div>
    </details>
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
    if (!name) return setStatus('Label name is required', true);
    form.elements.name.value = '';
    await createLabel(name, color);
  });

  document.querySelectorAll('.edit-label').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = form.elements.name.value.trim();
      const color = form.elements.color.value;
      if (!name) return setStatus('Label name is required', true);
      await updateLabel(form.dataset.labelId, name, color);
    });
    form.querySelector('.delete-label')?.addEventListener('click', async () => {
      if (confirm('Delete this label from all cards?')) await deleteLabel(form.dataset.labelId);
    });
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

  document.querySelectorAll('.card-label-toggle').forEach((input) => {
    input.addEventListener('change', async () => {
      const cardId = input.dataset.cardId;
      const labelId = input.value;
      if (input.checked) await assignLabel(cardId, labelId);
      else await unassignLabel(cardId, labelId);
    });
  });

  document.querySelectorAll('.card-tools, .card-tools *').forEach((el) => {
    el.addEventListener('mousedown', (event) => event.stopPropagation());
    el.addEventListener('dragstart', (event) => event.preventDefault());
  });

  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      if (event.target.closest('.card-tools')) return event.preventDefault();
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
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    let message = 'Request failed';
    try { message = (await response.json()).error || message; } catch {}
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

async function updateLabel(id, name, color) {
  try {
    await request(`/api/labels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
  } catch (error) {
    setStatus(`Label update failed: ${error.message}`, true);
  }
}

async function deleteLabel(id) {
  try {
    await request(`/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    selectedLabelIds.delete(id);
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
    await loadAll();
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    await request(`/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
    await loadAll();
  }
}

function applyMutation(message) {
  if (message.labels) {
    labels = [...message.labels].sort(compareLabels);
    for (const id of [...selectedLabelIds]) {
      if (!labels.some((label) => label.id === id)) selectedLabelIds.delete(id);
    }
  }

  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (!message.card) return;
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
  const boardResponse = await fetch(`${API_BASE}/api/board`);
  const labelsResponse = await fetch(`${API_BASE}/api/labels`);
  if (!boardResponse.ok) throw new Error('Could not load board');
  if (!labelsResponse.ok) throw new Error('Could not load labels');
  board = normalizeBoard(await boardResponse.json());
  labels = [...(await labelsResponse.json())].sort(compareLabels);
  for (const id of [...selectedLabelIds]) {
    if (!labels.some((label) => label.id === id)) selectedLabelIds.delete(id);
  }
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
