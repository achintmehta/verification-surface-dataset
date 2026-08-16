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

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function compareLabels(a, b) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
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
  const unique = new Map();
  for (const label of nextLabels || []) unique.set(label.id, label);
  return [...unique.values()].sort(compareLabels);
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
    ${renderLabelPanel()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderLabelPanel() {
  return `
    <section class="labels-panel" aria-label="Labels">
      <div class="filter-bar">
        <strong>Filter by labels</strong>
        <div class="filter-options">
          ${
            labels.length === 0
              ? '<span class="muted">No labels yet</span>'
              : labels
                  .map(
                    (label) => `
                      <label class="filter-option">
                        <input type="checkbox" data-filter-label-id="${escapeHtml(label.id)}" ${selectedLabelIds.has(label.id) ? 'checked' : ''} />
                        <span class="label-chip" style="--chip-color:${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
                      </label>
                    `
                  )
                  .join('')
          }
        </div>
        <button type="button" id="clear-filters" ${selectedLabelIds.size === 0 ? 'disabled' : ''}>Clear filter</button>
      </div>
      <details class="label-manager">
        <summary>Manage labels</summary>
        <form id="create-label" class="create-label">
          <input name="name" type="text" maxlength="80" placeholder="Label name" autocomplete="off" />
          <input name="color" type="color" value="#2563eb" title="Label color" />
          <button type="submit">Create label</button>
        </form>
        <div class="label-list">
          ${
            labels.length === 0
              ? '<p class="muted">Create labels, then add them to cards.</p>'
              : labels
                  .map(
                    (label) => `
                      <form class="label-row" data-label-id="${escapeHtml(label.id)}">
                        <span class="label-chip" style="--chip-color:${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
                        <input name="name" type="text" maxlength="80" value="${escapeHtml(label.name)}" />
                        <input name="color" type="color" value="${escapeHtml(label.color)}" />
                        <button type="submit">Save</button>
                        <button type="button" class="delete-label">Delete</button>
                      </form>
                    `
                  )
                  .join('')
          }
        </div>
      </details>
    </section>
  `;
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
  const assigned = new Set((card.labels || []).map((label) => label.id));
  const available = labels.filter((label) => !assigned.has(label.id));
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-labels">
        ${(card.labels || [])
          .map(
            (label) => `
              <span class="label-chip" style="--chip-color:${escapeHtml(label.color)}">
                ${escapeHtml(label.name)}
                <button type="button" class="remove-card-label" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}" aria-label="Remove ${escapeHtml(label.name)}">×</button>
              </span>
            `
          )
          .join('')}
      </div>
      <form class="assign-label" data-card-id="${escapeHtml(card.id)}">
        <select name="labelId" ${available.length === 0 ? 'disabled' : ''}>
          <option value="">${available.length === 0 ? 'No labels to add' : 'Add label…'}</option>
          ${available.map((label) => `<option value="${escapeHtml(label.id)}">${escapeHtml(label.name)}</option>`).join('')}
        </select>
        <button type="submit" ${available.length === 0 ? 'disabled' : ''}>Add</button>
      </form>
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

  document.querySelectorAll('[data-filter-label-id]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) selectedLabelIds.add(input.dataset.filterLabelId);
      else selectedLabelIds.delete(input.dataset.filterLabelId);
      render();
      setStatus(eventSource?.readyState === EventSource.OPEN ? 'Live' : 'Connecting…');
    });
  });

  document.querySelector('#clear-filters')?.addEventListener('click', () => {
    selectedLabelIds.clear();
    render();
    setStatus(eventSource?.readyState === EventSource.OPEN ? 'Live' : 'Connecting…');
  });

  document.querySelector('#create-label')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return setStatus('Label name is required', true);
    await createLabel(name, color);
    form.reset();
    form.elements.color.value = '#2563eb';
  });

  document.querySelectorAll('.label-row').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = form.elements.name.value.trim();
      const color = form.elements.color.value;
      if (!name) return setStatus('Label name is required', true);
      await updateLabel(form.dataset.labelId, { name, color });
    });
    form.querySelector('.delete-label')?.addEventListener('click', async () => {
      if (confirm('Delete this label and remove it from all cards?')) await deleteLabel(form.dataset.labelId);
    });
  });

  document.querySelectorAll('.assign-label').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const labelId = form.elements.labelId.value;
      if (labelId) await assignLabel(form.dataset.cardId, labelId);
    });
  });

  document.querySelectorAll('.remove-card-label').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      await unassignLabel(button.dataset.cardId, button.dataset.labelId);
    });
  });

  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      draggedCardId = cardEl.dataset.cardId;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
      cardEl.classList.add('dragging');
    });
    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      draggedCardId = null;
      document.querySelectorAll('.cards.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      list.classList.add('drop-target');
      const dragging = document.querySelector('.card.dragging');
      if (!dragging) return;
      const afterElement = getDragAfterElement(list, event.clientY);
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
      const { beforeId, afterId } = getSiblingIds(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
      await moveCard(cardId, columnId, beforeId, afterId);
    });
  });
}

function getDragAfterElement(container, y) {
  const cards = [...container.querySelectorAll('.card:not(.dragging)')];
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

function getSiblingIds(list, cardId) {
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

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let message = 'Request failed';
    try {
      message = (await response.json()).error || message;
    } catch {
      // ignore non-JSON errors
    }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function createCard(columnId, text) {
  try {
    await requestJson(`${API_BASE}/api/cards`, {
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
    await requestJson(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
  } catch (error) {
    setStatus(`Move failed: ${error.message}`, true);
    await loadBoard(false);
  }
}

async function createLabel(name, color) {
  try {
    await requestJson(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
  } catch (error) {
    setStatus(`Label create failed: ${error.message}`, true);
  }
}

async function updateLabel(id, body) {
  try {
    await requestJson(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    setStatus(`Label update failed: ${error.message}`, true);
  }
}

async function deleteLabel(id) {
  try {
    await requestJson(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    selectedLabelIds.delete(id);
  } catch (error) {
    setStatus(`Label delete failed: ${error.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    await requestJson(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
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
    await requestJson(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, {
      method: 'DELETE',
    });
  } catch (error) {
    setStatus(`Remove label failed: ${error.message}`, true);
  }
}

function applyMutation(message) {
  if (message.labels) {
    labels = normalizeLabels(message.labels);
    const labelIds = new Set(labels.map((label) => label.id));
    selectedLabelIds = new Set([...selectedLabelIds].filter((id) => labelIds.has(id)));
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

async function loadLabels() {
  labels = normalizeLabels(await requestJson(`${API_BASE}/api/labels`));
  const labelIds = new Set(labels.map((label) => label.id));
  selectedLabelIds = new Set([...selectedLabelIds].filter((id) => labelIds.has(id)));
}

async function loadBoard(shouldRender = true) {
  board = normalizeBoard(await requestJson(`${API_BASE}/api/board`));
  if (shouldRender) render();
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
    await Promise.all([loadBoard(false), loadLabels()]);
    render();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
