import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [], labels: [] };
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let selectedLabelIds = new Set();

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
  const labels = [...(nextBoard.labels || [])].sort(compareLabels);
  const labelIds = new Set(labels.map((label) => label.id));
  selectedLabelIds = new Set([...selectedLabelIds].filter((id) => labelIds.has(id)));
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
  return { columns, labels };
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function compareLabels(a, b) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
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
          ${board.labels.length ? board.labels.map(renderFilterOption).join('') : '<span class="muted">No labels yet</span>'}
          ${selectedLabelIds.size ? '<button type="button" class="clear-filter">Clear filter</button>' : ''}
        </div>
      </div>
      <div class="label-manager">
        <h2>Labels</h2>
        <form class="create-label">
          <input name="name" type="text" maxlength="100" placeholder="New label name" autocomplete="off" />
          <input name="color" type="color" value="#2563eb" title="Label color" />
          <button type="submit">Create</button>
        </form>
        <div class="label-list">
          ${board.labels.length ? board.labels.map(renderLabelEditor).join('') : '<span class="muted">Create labels to tag cards.</span>'}
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
    <label class="filter-chip" style="--label-color:${escapeHtml(label.color)}">
      <input type="checkbox" class="label-filter" value="${escapeHtml(label.id)}" ${checked} />
      <span>${escapeHtml(label.name)}</span>
    </label>
  `;
}

function renderLabelEditor(label) {
  return `
    <form class="label-editor" data-label-id="${escapeHtml(label.id)}">
      <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
      <input name="name" type="text" maxlength="100" value="${escapeHtml(label.name)}" />
      <input name="color" type="color" value="${escapeHtml(label.color)}" />
      <button type="submit">Save</button>
      <button type="button" class="delete-label">Delete</button>
    </form>
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
        ${!visibleCards.length && selectedLabelIds.size ? '<div class="empty-filter">No matching cards</div>' : ''}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const assigned = new Set((card.labels || []).map((label) => label.id));
  const available = board.labels.filter((label) => !assigned.has(label.id));
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-labels">
        ${(card.labels || []).map((label) => `
          <span class="card-label-chip" style="--label-color:${escapeHtml(label.color)}">
            ${escapeHtml(label.name)}
            <button type="button" class="remove-card-label" data-label-id="${escapeHtml(label.id)}" title="Remove ${escapeHtml(label.name)}">×</button>
          </span>
        `).join('')}
      </div>
      <form class="assign-label" data-card-id="${escapeHtml(card.id)}">
        <select name="labelId" ${available.length ? '' : 'disabled'}>
          <option value="">${available.length ? 'Add label…' : 'No labels to add'}</option>
          ${available.map((label) => `<option value="${escapeHtml(label.id)}">${escapeHtml(label.name)}</option>`).join('')}
        </select>
        <button type="submit" ${available.length ? '' : 'disabled'}>Add</button>
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
    form.querySelector('.delete-label').addEventListener('click', async () => {
      if (confirm('Delete this label and remove it from all cards?')) await deleteLabel(form.dataset.labelId);
    });
  });

  document.querySelectorAll('.label-filter').forEach((input) => {
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
      const cardEl = button.closest('.card');
      await unassignLabel(cardEl.dataset.cardId, button.dataset.labelId);
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

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create label failed');
  } catch (error) {
    setStatus(`Label create failed: ${error.message}`, true);
  }
}

async function updateLabel(labelId, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update label failed');
  } catch (error) {
    setStatus(`Label update failed: ${error.message}`, true);
  }
}

async function deleteLabel(labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Delete label failed');
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
    if (!response.ok) throw new Error((await response.json()).error || 'Assign label failed');
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Remove label failed');
  } catch (error) {
    setStatus(`Remove failed: ${error.message}`, true);
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
