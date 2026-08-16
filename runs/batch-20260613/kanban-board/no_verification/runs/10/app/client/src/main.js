import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || (location.port === '5173' ? 'http://localhost:3000' : '');
const app = document.querySelector('#app');

let board = { columns: [] };
let draggingCardId = null;
let reconnectNoticeTimer = null;

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setStatus(message, tone = 'info') {
  const status = document.querySelector('[data-status]');
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
}

function cardCount() {
  return board.columns.reduce((sum, column) => sum + column.cards.length, 0);
}

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <p class="eyebrow">PGLite + SSE</p>
        <h1>Collaborative Kanban</h1>
      </div>
      <div class="status" data-status data-tone="info">${cardCount()} cards synced</div>
    </header>
    <main class="board" aria-label="Kanban board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindColumnEvents();
  setStatus(`${cardCount()} cards synced`, 'ok');
}

function renderColumn(column) {
  return `
    <section class="column" data-column-id="${htmlEscape(column.id)}">
      <header class="column__header">
        <h2>${htmlEscape(column.title)}</h2>
        <span>${column.cards.length}</span>
      </header>
      <div class="card-list" data-card-list data-column-id="${htmlEscape(column.id)}">
        ${column.cards.map(renderCard).join('')}
      </div>
      <form class="new-card" data-new-card-form data-column-id="${htmlEscape(column.id)}">
        <input name="text" type="text" maxlength="240" autocomplete="off" placeholder="Add a card…" aria-label="New card text for ${htmlEscape(column.title)}" />
        <button type="submit">Add</button>
      </form>
    </section>
  `;
}

function renderCard(card) {
  return `
    <article class="card" draggable="true" data-card-id="${htmlEscape(card.id)}">
      <p>${htmlEscape(card.text)}</p>
    </article>
  `;
}

function bindColumnEvents() {
  document.querySelectorAll('[data-new-card-form]').forEach((form) => {
    form.addEventListener('submit', createCard);
  });

  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', onDragStart);
    card.addEventListener('dragend', onDragEnd);
  });

  document.querySelectorAll('[data-card-list]').forEach((list) => {
    list.addEventListener('dragover', onDragOver);
    list.addEventListener('drop', onDrop);
    list.addEventListener('dragenter', () => list.classList.add('card-list--over'));
    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) list.classList.remove('card-list--over');
    });
  });
}

async function loadBoard() {
  const response = await fetch(apiUrl('/api/board'));
  if (!response.ok) throw new Error('Failed to load board');
  board = await response.json();
  render();
}

async function createCard(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.elements.text;
  const text = input.value.trim();
  const columnId = form.dataset.columnId;
  if (!text) return;

  input.value = '';
  form.querySelector('button').disabled = true;
  try {
    const response = await fetch(apiUrl('/api/cards'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
    setStatus('Card created; waiting for canonical sync…', 'info');
  } catch (error) {
    input.value = text;
    setStatus(error.message, 'error');
  } finally {
    form.querySelector('button').disabled = false;
    input.focus();
  }
}

function onDragStart(event) {
  draggingCardId = event.currentTarget.dataset.cardId;
  event.currentTarget.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggingCardId);
}

function onDragEnd(event) {
  event.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.card-list--over').forEach((list) => list.classList.remove('card-list--over'));
  draggingCardId = null;
}

function onDragOver(event) {
  event.preventDefault();
  const list = event.currentTarget;
  const dragging = document.querySelector('.card.dragging');
  if (!dragging) return;

  const beforeElement = getCardAfterPointer(list, event.clientY);
  if (beforeElement) list.insertBefore(dragging, beforeElement);
  else list.appendChild(dragging);
}

async function onDrop(event) {
  event.preventDefault();
  const list = event.currentTarget;
  list.classList.remove('card-list--over');
  const card = document.querySelector('.card.dragging');
  const cardId = card?.dataset.cardId || draggingCardId || event.dataTransfer.getData('text/plain');
  if (!cardId) return;

  const columnId = list.dataset.columnId;
  const { beforeId, afterId } = neighboringIds(cardId, list);

  // Optimistically update local state to match the DOM immediately. The SSE
  // response contains the authoritative full board and will snap us back if a
  // concurrent write picked a different canonical order.
  applyOptimisticMove(cardId, columnId, beforeId, afterId);
  setStatus('Move sent; reconciling…', 'info');

  try {
    const response = await fetch(apiUrl(`/api/cards/${encodeURIComponent(cardId)}/move`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
  } catch (error) {
    setStatus(`${error.message}; reloading canonical board…`, 'error');
    await loadBoard();
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

function neighboringIds(cardId, list) {
  const cards = [...list.querySelectorAll('.card')];
  const index = cards.findIndex((card) => card.dataset.cardId === cardId);
  return {
    beforeId: cards[index + 1]?.dataset.cardId || null,
    afterId: cards[index - 1]?.dataset.cardId || null,
  };
}

function applyOptimisticMove(cardId, targetColumnId, beforeId, afterId) {
  let movedCard = null;
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) {
      [movedCard] = column.cards.splice(index, 1);
      break;
    }
  }
  if (!movedCard) return;
  movedCard = { ...movedCard, columnId: targetColumnId };
  const targetColumn = board.columns.find((column) => column.id === targetColumnId);
  if (!targetColumn) {
    const originalColumn = board.columns.find((column) => column.id === movedCard.columnId);
    if (originalColumn) originalColumn.cards.push(movedCard);
    return;
  }

  let insertIndex = targetColumn.cards.length;
  if (beforeId) {
    const beforeIndex = targetColumn.cards.findIndex((card) => card.id === beforeId);
    if (beforeIndex !== -1) insertIndex = beforeIndex;
  } else if (afterId) {
    const afterIndex = targetColumn.cards.findIndex((card) => card.id === afterId);
    if (afterIndex !== -1) insertIndex = afterIndex + 1;
  }
  targetColumn.cards.splice(insertIndex, 0, movedCard);
}

function replaceWithCanonical(nextBoard, reason = 'Synced') {
  // Full replacement is deliberately simple and convergence-friendly: if two
  // clients race, every SSE message carries the server's entire committed board.
  board = nextBoard;
  render();
  setStatus(`${reason}: ${cardCount()} cards synced`, 'ok');
}

function connectStream() {
  const stream = new EventSource(apiUrl('/api/stream'));

  const handleCanonicalEvent = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.board) replaceWithCanonical(payload.board, payload.type === 'move' ? 'Move reconciled' : 'Card synced');
  };

  stream.addEventListener('board', handleCanonicalEvent);
  stream.addEventListener('create', handleCanonicalEvent);
  stream.addEventListener('move', handleCanonicalEvent);

  stream.onopen = () => {
    clearTimeout(reconnectNoticeTimer);
    setStatus('Live connection established', 'ok');
  };

  stream.onerror = () => {
    setStatus('Live connection interrupted; retrying…', 'error');
    clearTimeout(reconnectNoticeTimer);
    reconnectNoticeTimer = setTimeout(() => loadBoard().catch(() => {}), 2000);
  };
}

loadBoard()
  .then(connectStream)
  .catch((error) => {
    app.innerHTML = `<div class="fatal"><h1>Unable to load board</h1><p>${htmlEscape(error.message)}</p></div>`;
  });
