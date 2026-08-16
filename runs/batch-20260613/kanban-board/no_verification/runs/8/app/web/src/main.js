import './styles.css';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let droppedDuringDrag = false;
let eventSource = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setStatus(message, tone = 'neutral') {
  const status = document.querySelector('[data-status]');
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
}

function sortCards(cards) {
  return [...cards].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return String(a.createdAt || a.id).localeCompare(String(b.createdAt || b.id));
  });
}

function normalizeBoard(nextBoard) {
  return {
    columns: [...(nextBoard?.columns || [])]
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map((column) => ({ ...column, cards: sortCards(column.cards || []) }))
  };
}

function findCard(cardId) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) return { card: column.cards[index], column, index };
  }
  return null;
}

function applyBoard(nextBoard) {
  board = normalizeBoard(nextBoard);
  render();
}

async function fetchBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Failed to load board');
  applyBoard(await response.json());
}

function render() {
  const previousStatus = document.querySelector('[data-status]');
  const previousStatusText = previousStatus?.textContent || 'Connected clients converge through server state';
  const previousStatusTone = previousStatus?.dataset.tone || 'neutral';
  const activeElement = document.activeElement;
  const activeFormColumn = activeElement?.closest?.('form[data-create-form]')?.dataset.columnId;
  const activeValue = activeFormColumn ? activeElement.value : '';

  app.innerHTML = `
    <header class="app-header">
      <div>
        <p class="eyebrow">PGLite + SSE</p>
        <h1>Collaborative Kanban</h1>
      </div>
      <div class="status" data-status data-tone="${escapeHtml(previousStatusTone)}">${escapeHtml(previousStatusText)}</div>
    </header>
    <main class="board" aria-label="Kanban board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;

  if (activeFormColumn) {
    const input = document.querySelector(`form[data-column-id="${CSS.escape(activeFormColumn)}"] input`);
    if (input) {
      input.value = activeValue;
      input.focus();
    }
  }

  attachHandlers();
}

function renderColumn(column) {
  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <div class="column-header">
        <h2>${escapeHtml(column.title)}</h2>
        <span class="count">${column.cards.length}</span>
      </div>
      <div class="cards" data-card-list data-column-id="${escapeHtml(column.id)}">
        ${column.cards.map(renderCard).join('')}
      </div>
      <form class="card-form" data-create-form data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="300" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
    </section>
  `;
}

function renderCard(card) {
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}">
      <p>${escapeHtml(card.text)}</p>
    </article>
  `;
}

function attachHandlers() {
  document.querySelectorAll('[data-create-form]').forEach((form) => {
    form.addEventListener('submit', handleCreateCard);
  });

  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', handleDragStart);
    card.addEventListener('dragend', handleDragEnd);
  });

  document.querySelectorAll('[data-card-list]').forEach((list) => {
    list.addEventListener('dragover', handleDragOver);
    list.addEventListener('drop', handleDrop);
    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));
  });
}

async function handleCreateCard(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.elements.text;
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  form.querySelector('button').disabled = true;
  try {
    const response = await fetch(`${API_BASE}/api/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: form.dataset.columnId, text })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Could not create card');
    const payload = await response.json();
    if (payload.card) upsertCanonicalCard(payload.card);
    setStatus('Card created', 'ok');
  } catch (error) {
    input.value = text;
    setStatus(error.message, 'error');
  } finally {
    form.querySelector('button').disabled = false;
  }
}

function handleDragStart(event) {
  draggedCardId = event.currentTarget.dataset.cardId;
  droppedDuringDrag = false;
  event.currentTarget.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedCardId);
}

function handleDragEnd(event) {
  event.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.drop-target').forEach((element) => element.classList.remove('drop-target'));
  if (!droppedDuringDrag) render();
  draggedCardId = null;
}

function handleDragOver(event) {
  event.preventDefault();
  const list = event.currentTarget;
  list.classList.add('drop-target');
  const dragging = document.querySelector('.card.dragging');
  if (!dragging) return;

  const before = getCardAfterPointer(list, event.clientY);
  if (before) list.insertBefore(dragging, before);
  else list.appendChild(dragging);
}

async function handleDrop(event) {
  event.preventDefault();
  const list = event.currentTarget;
  list.classList.remove('drop-target');
  const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
  if (!cardId) return;

  droppedDuringDrag = true;
  const columnId = list.dataset.columnId;
  const { beforeId, afterId } = placementFromDom(list, cardId);

  optimisticMove(cardId, columnId, beforeId, afterId);
  render();
  setStatus('Saving move…');

  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Could not move card');
    const payload = await response.json();
    if (payload.card) upsertCanonicalCard(payload.card);
    setStatus('Move saved', 'ok');
  } catch (error) {
    setStatus(`${error.message}; reloading canonical state`, 'error');
    await fetchBoard().catch(() => {});
  }
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

function placementFromDom(list, cardId) {
  const cards = [...list.querySelectorAll('.card')];
  const index = cards.findIndex((element) => element.dataset.cardId === cardId);
  const previous = index > 0 ? cards[index - 1] : null;
  const next = index !== -1 && index < cards.length - 1 ? cards[index + 1] : null;
  return {
    afterId: previous?.dataset.cardId || null,
    beforeId: next?.dataset.cardId || null
  };
}

function optimisticMove(cardId, columnId, beforeId, afterId) {
  const located = findCard(cardId);
  if (!located) return;
  const moving = { ...located.card, columnId, optimistic: true };

  for (const column of board.columns) {
    column.cards = column.cards.filter((card) => card.id !== cardId);
  }

  const target = board.columns.find((column) => column.id === columnId);
  if (!target) return;

  let index = target.cards.length;
  if (beforeId) {
    const beforeIndex = target.cards.findIndex((card) => card.id === beforeId);
    if (beforeIndex !== -1) index = beforeIndex;
  } else if (afterId) {
    const afterIndex = target.cards.findIndex((card) => card.id === afterId);
    if (afterIndex !== -1) index = afterIndex + 1;
  }

  target.cards.splice(index, 0, moving);
}

function upsertCanonicalCard(card) {
  for (const column of board.columns) {
    column.cards = column.cards.filter((existing) => existing.id !== card.id);
  }
  const target = board.columns.find((column) => column.id === card.columnId);
  if (target) target.cards.push(card);
  board = normalizeBoard(board);
  render();
}

function connectStream() {
  eventSource?.close();
  eventSource = new EventSource(`${API_BASE}/api/stream`);

  const handleMessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.board) applyBoard(payload.board);
    else if (payload.card) upsertCanonicalCard(payload.card);
    setStatus('Live and synchronized', 'ok');
  };

  eventSource.addEventListener('connected', handleMessage);
  eventSource.addEventListener('card:create', handleMessage);
  eventSource.addEventListener('card:move', handleMessage);
  eventSource.onopen = () => setStatus('Live connection open', 'ok');
  eventSource.onerror = () => setStatus('Live connection interrupted; retrying…', 'error');
}

app.innerHTML = '<div class="loading">Loading board…</div>';
fetchBoard()
  .then(connectStream)
  .then(() => setStatus('Live and synchronized', 'ok'))
  .catch((error) => {
    app.innerHTML = `<div class="loading error"><h1>Unable to load board</h1><p>${escapeHtml(error.message)}</p></div>`;
  });
