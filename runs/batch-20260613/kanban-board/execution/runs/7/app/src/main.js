import './styles.css';

const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let draggedFromColumnId = null;
let eventSource = null;

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
    if (index !== -1) return { column, card: column.cards[index], index };
  }
  return null;
}

function removeCardFromState(cardId) {
  const found = findCard(cardId);
  if (!found) return null;
  return found.column.cards.splice(found.index, 1)[0];
}

function sortColumnsAndCards() {
  board.columns.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  for (const column of board.columns) {
    column.cards.sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
}

function replaceBoard(nextBoard) {
  const seen = new Set();
  board = {
    columns: (nextBoard.columns || []).map((column) => {
      const cards = [];
      for (const card of column.cards || []) {
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        cards.push({ ...card });
      }
      return { ...column, cards };
    })
  };
  sortColumnsAndCards();
  render();
}

function reconcileCanonicalCard(card) {
  if (!card) return;
  removeCardFromState(card.id);
  const target = board.columns.find((column) => column.id === card.columnId);
  if (target) target.cards.push({ ...card });
  sortColumnsAndCards();
  render();
}

function getColumnCardsElement(columnId) {
  return document.querySelector(`.cards[data-column-id="${CSS.escape(columnId)}"]`);
}

function getDropTargetCard(container, y) {
  const candidates = [...container.querySelectorAll('.card:not(.dragging)')];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const element of candidates) {
    const box = element.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, element };
    }
  }
  return closest.element;
}

function cardHtml(card) {
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}">
      <div class="card-text">${escapeHtml(card.text)}</div>
    </article>
  `;
}

function columnHtml(column) {
  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <header class="column-header">
        <h2>${escapeHtml(column.title)}</h2>
        <span class="count">${column.cards.length}</span>
      </header>
      <form class="new-card-form" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card..." autocomplete="off" />
        <button type="submit" title="Create card">+</button>
      </form>
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${column.cards.map(cardHtml).join('')}
      </div>
    </section>
  `;
}

function render() {
  app.innerHTML = `
    <main class="shell">
      <header class="app-header">
        <div>
          <h1>Collaborative Kanban</h1>
          <p>Drag cards between columns. Every connected browser converges through server-sent events.</p>
        </div>
        <div class="connection" id="connection-status">Connecting…</div>
      </header>
      <div class="board">
        ${board.columns.map(columnHtml).join('')}
      </div>
    </main>
  `;
  attachDomHandlers();
  updateConnectionStatus(eventSource?.readyState === EventSource.OPEN ? 'Live' : 'Connecting…');
}

function updateConnectionStatus(text, problem = false) {
  const status = document.querySelector('#connection-status');
  if (!status) return;
  status.textContent = text;
  status.classList.toggle('problem', problem);
}

function attachDomHandlers() {
  document.querySelectorAll('.new-card-form').forEach((form) => {
    form.addEventListener('submit', handleCreateCard);
  });

  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', handleDragStart);
    card.addEventListener('dragend', handleDragEnd);
  });

  document.querySelectorAll('.cards').forEach((container) => {
    container.addEventListener('dragover', handleDragOver);
    container.addEventListener('dragleave', handleDragLeave);
    container.addEventListener('drop', handleDrop);
  });
}

async function handleCreateCard(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.elements.text;
  const text = input.value.trim();
  const columnId = form.dataset.columnId;
  if (!text) return;

  input.value = '';
  try {
    const response = await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });
    if (!response.ok) throw new Error(await response.text());
    const card = await response.json();
    reconcileCanonicalCard(card);
  } catch (error) {
    console.error(error);
    alert('Could not create card. Please try again.');
    input.value = text;
  }
}

function handleDragStart(event) {
  const card = event.currentTarget;
  draggedCardId = card.dataset.cardId;
  draggedFromColumnId = card.closest('.cards')?.dataset.columnId || null;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedCardId);
  requestAnimationFrame(() => card.classList.add('dragging'));
}

function handleDragEnd() {
  document.querySelectorAll('.dragging').forEach((element) => element.classList.remove('dragging'));
  document.querySelectorAll('.drop-active').forEach((element) => element.classList.remove('drop-active'));
  draggedCardId = null;
  draggedFromColumnId = null;
}

function handleDragOver(event) {
  if (!draggedCardId) return;
  event.preventDefault();
  const container = event.currentTarget;
  container.classList.add('drop-active');
  const afterElement = getDropTargetCard(container, event.clientY);
  const dragging = document.querySelector(`.card[data-card-id="${CSS.escape(draggedCardId)}"]`);
  if (!dragging) return;
  if (afterElement == null) container.appendChild(dragging);
  else container.insertBefore(dragging, afterElement);
}

function handleDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) {
    event.currentTarget.classList.remove('drop-active');
  }
}

async function handleDrop(event) {
  event.preventDefault();
  const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
  const container = event.currentTarget;
  container.classList.remove('drop-active');
  if (!cardId) return;

  const columnId = container.dataset.columnId;
  const cardElement = container.querySelector(`.card[data-card-id="${CSS.escape(cardId)}"]`);
  if (!cardElement) return;

  const previousCard = cardElement.previousElementSibling?.classList.contains('card') ? cardElement.previousElementSibling : null;
  const nextCard = cardElement.nextElementSibling?.classList.contains('card') ? cardElement.nextElementSibling : null;
  const afterId = previousCard?.dataset.cardId || null;
  const beforeId = nextCard?.dataset.cardId || null;

  optimisticMove(cardId, columnId, beforeId, afterId);

  try {
    const response = await fetch(`/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId })
    });
    if (!response.ok) throw new Error(await response.text());
    const canonicalCard = await response.json();
    reconcileCanonicalCard(canonicalCard);
  } catch (error) {
    console.error(error);
    // The server is authoritative; refetch to undo any optimistic state that failed.
    await loadBoard();
    alert('Could not move card. The board has been refreshed.');
  }
}

function optimisticMove(cardId, columnId, beforeId, afterId) {
  const card = removeCardFromState(cardId);
  const target = board.columns.find((column) => column.id === columnId);
  if (!card || !target) return;

  card.columnId = columnId;
  const beforeIndex = beforeId ? target.cards.findIndex((existing) => existing.id === beforeId) : -1;
  const afterIndex = afterId ? target.cards.findIndex((existing) => existing.id === afterId) : -1;
  let insertIndex = target.cards.length;
  if (beforeIndex >= 0) insertIndex = beforeIndex;
  else if (afterIndex >= 0) insertIndex = afterIndex + 1;

  const previous = target.cards[insertIndex - 1];
  const next = target.cards[insertIndex];
  if (previous && next) card.position = (previous.position + next.position) / 2;
  else if (previous) card.position = previous.position + 1000;
  else if (next) card.position = next.position / 2;
  else card.position = 1000;

  target.cards.splice(insertIndex, 0, card);
  render();
}

function connectStream() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/stream');

  eventSource.onopen = () => updateConnectionStatus('Live');
  eventSource.onerror = () => updateConnectionStatus('Reconnecting…', true);

  const handleMutation = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.board) replaceBoard(payload.board);
    else if (payload.card) reconcileCanonicalCard(payload.card);
  };

  eventSource.addEventListener('create', handleMutation);
  eventSource.addEventListener('move', handleMutation);
}

async function loadBoard() {
  const response = await fetch('/api/board');
  if (!response.ok) throw new Error(await response.text());
  replaceBoard(await response.json());
}

async function boot() {
  app.innerHTML = '<div class="loading">Loading board…</div>';
  try {
    await loadBoard();
    connectStream();
  } catch (error) {
    console.error(error);
    app.innerHTML = '<div class="loading error">Could not load the board. Is the server running?</div>';
  }
}

boot();
