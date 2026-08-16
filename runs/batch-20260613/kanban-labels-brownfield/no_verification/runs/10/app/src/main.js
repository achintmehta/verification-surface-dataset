import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [], labels: [] };
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
  return escapeHtml(value).replaceAll('`', '&#096;');
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
  const labelMap = new Map((nextBoard.labels || []).map((label) => [label.id, label]));
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
        .map((card) => ({
          ...card,
          labels: [...(card.labels || [])]
            .map((label) => labelMap.get(label.id) || label)
            .sort(compareLabels),
        }))
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  const labels = [...(nextBoard.labels || [])].sort(compareLabels);
  selectedLabelIds = new Set([...selectedLabelIds].filter((id) => labelMap.has(id)));
  return { columns, labels };
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

function getLabels() {
  return board.labels || [];
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
    <section class="label-panel">
      <div class="filter-bar">
        <h2>Filter by labels</h2>
        <div class="filter-options">
          ${renderFilterOptions()}
        </div>
      </div>
      <details class="label-manager" open>
        <summary>Manage labels</summary>
        <form class="create-label">
          <input name="name" type="text" maxlength="80" placeholder="Label name" autocomplete="off" />
          <input name="color" type="color" value="#2563eb" title="Label color" />
          <button type="submit">Create label</button>
        </form>
        <div class="label-list">
          ${getLabels().length ? getLabels().map(renderLabelEditor).join('') : '<p class="empty-labels">No labels yet.</p>'}
        </div>
      </details>
    </section>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderFilterOptions() {
  if (getLabels().length === 0) return '<span class="empty-labels">No labels to filter.</span>';
  return `
    ${getLabels()
      .map(
        (label) => `
          <label class="filter-chip">
            <input type="checkbox" class="filter-label" value="${escapeAttr(label.id)}" ${selectedLabelIds.has(label.id) ? 'checked' : ''} />
            <span class="label-color" style="background:${escapeAttr(label.color)}"></span>
            ${escapeHtml(label.name)}
          </label>`
      )
      .join('')}
    <button type="button" class="clear-filters" ${selectedLabelIds.size === 0 ? 'disabled' : ''}>Clear</button>
  `;
}

function renderLabelEditor(label) {
  return `
    <form class="label-editor" data-label-id="${escapeAttr(label.id)}">
      <input name="name" type="text" maxlength="80" value="${escapeAttr(label.name)}" />
      <input name="color" type="color" value="${escapeAttr(label.color)}" />
      <button type="submit">Save</button>
      <button type="button" class="delete-label">Delete</button>
    </form>
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
        ${visibleCards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const assigned = new Set((card.labels || []).map((label) => label.id));
  const availableLabels = getLabels().filter((label) => !assigned.has(label.id));
  return `
    <article class="card" draggable="true" data-card-id="${escapeAttr(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-labels">
        ${(card.labels || []).map((label) => renderCardLabel(card.id, label)).join('')}
      </div>
      <div class="card-label-actions">
        <select class="assign-label" aria-label="Assign label" ${availableLabels.length === 0 ? 'disabled' : ''}>
          <option value="">Add label…</option>
          ${availableLabels.map((label) => `<option value="${escapeAttr(label.id)}">${escapeHtml(label.name)}</option>`).join('')}
        </select>
      </div>
    </article>
  `;
}

function renderCardLabel(cardId, label) {
  return `
    <span class="label-chip" style="background:${escapeAttr(label.color)}" title="${escapeAttr(label.name)}">
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

  document.querySelector('.create-label')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return setStatus('Label name is required', true);
    await createLabel(name, color);
    form.reset();
    form.elements.color.value = '#2563eb';
  });

  document.querySelectorAll('.label-editor').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await updateLabel(form.dataset.labelId, form.elements.name.value.trim(), form.elements.color.value);
    });
    form.querySelector('.delete-label')?.addEventListener('click', async () => {
      if (confirm('Delete this label from all cards?')) await deleteLabel(form.dataset.labelId);
    });
  });

  document.querySelectorAll('.filter-label').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedLabelIds.add(checkbox.value);
      else selectedLabelIds.delete(checkbox.value);
      render();
    });
  });

  document.querySelector('.clear-filters')?.addEventListener('click', () => {
    selectedLabelIds.clear();
    render();
  });

  document.querySelectorAll('.assign-label').forEach((select) => {
    select.addEventListener('mousedown', (event) => event.stopPropagation());
    select.addEventListener('change', async (event) => {
      const card = event.currentTarget.closest('.card');
      const labelId = event.currentTarget.value;
      if (card?.dataset.cardId && labelId) await assignLabel(card.dataset.cardId, labelId);
    });
  });

  document.querySelectorAll('.remove-card-label').forEach((button) => {
    button.addEventListener('mousedown', (event) => event.stopPropagation());
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      await unassignLabel(button.dataset.cardId, button.dataset.labelId);
    });
  });

  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', () => {
      draggedCardId = card.dataset.cardId;
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
      if (!draggedCardId) return;
      list.classList.add('drop-target');
      const after = getDragAfterElement(list, event.clientY);
      const dragged = document.querySelector(`.card[data-card-id="${CSS.escape(draggedCardId)}"]`);
      if (!dragged) return;
      if (after == null) list.appendChild(dragged);
      else list.insertBefore(dragged, after);
    });

    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));

    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      if (!draggedCardId) return;
      const cardId = draggedCardId;
      const columnId = list.dataset.columnId;
      const { beforeId, afterId } = neighborIds(list, cardId);
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

function neighborIds(list, cardId) {
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
    const response = await fetch(
      `${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`,
      { method: 'DELETE' }
    );
    if (!response.ok) throw new Error((await response.json()).error || 'Remove label failed');
  } catch (error) {
    setStatus(`Remove label failed: ${error.message}`, true);
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
  const card = { ...message.card, labels: message.card.labels || [] };
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
