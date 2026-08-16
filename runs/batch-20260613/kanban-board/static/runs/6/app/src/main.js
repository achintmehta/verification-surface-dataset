import './styles.css';

const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let stream;

function cloneBoard(source) {
  return {
    columns: (source.columns || []).map((column) => ({
      ...column,
      cards: (column.cards || []).map((card) => ({ ...card }))
    }))
  };
}

function sortBoard(nextBoard) {
  nextBoard.columns.sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  for (const column of nextBoard.columns) {
    column.cards.sort(
      (a, b) =>
        Number(a.position) - Number(b.position) ||
        String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
        a.id.localeCompare(b.id)
    );
  }
  return nextBoard;
}

function setBoard(nextBoard) {
  board = sortBoard(cloneBoard(nextBoard));
  render();
}

async function loadBoard() {
  const response = await fetch('/api/board');
  if (!response.ok) throw new Error('Failed to load board');
  setBoard(await response.json());
}

function findCard(cardId, source = board) {
  for (const column of source.columns) {
    const card = column.cards.find((candidate) => candidate.id === cardId);
    if (card) return { card, column };
  }
  return null;
}

function applyCanonicalCard(card) {
  const next = cloneBoard(board);

  for (const column of next.columns) {
    column.cards = column.cards.filter((candidate) => candidate.id !== card.id);
  }

  const targetColumn = next.columns.find((column) => column.id === card.columnId);
  if (targetColumn) {
    targetColumn.cards.push({ ...card });
  }

  setBoard(next);
}

function optimisticMove(cardId, columnId, beforeId, afterId) {
  const next = cloneBoard(board);
  let movingCard = null;

  for (const column of next.columns) {
    const cardIndex = column.cards.findIndex((card) => card.id === cardId);
    if (cardIndex !== -1) {
      [movingCard] = column.cards.splice(cardIndex, 1);
      break;
    }
  }

  const targetColumn = next.columns.find((column) => column.id === columnId);
  if (!movingCard || !targetColumn) return;

  movingCard = { ...movingCard, columnId, optimistic: true };

  let insertionIndex = targetColumn.cards.length;
  if (beforeId) {
    const index = targetColumn.cards.findIndex((card) => card.id === beforeId);
    if (index !== -1) insertionIndex = index;
  } else if (afterId) {
    const index = targetColumn.cards.findIndex((card) => card.id === afterId);
    if (index !== -1) insertionIndex = index + 1;
  }

  targetColumn.cards.splice(Math.max(0, Math.min(insertionIndex, targetColumn.cards.length)), 0, movingCard);
  board = next;
  render();
}

function getDropIntent(listElement, clientY, draggedId) {
  const cards = [...listElement.querySelectorAll('.card:not(.dragging)')].filter(
    (element) => element.dataset.cardId !== draggedId
  );

  let beforeElement = null;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      beforeElement = card;
      break;
    }
  }

  if (beforeElement) {
    const beforeId = beforeElement.dataset.cardId;
    const beforeIndex = cards.indexOf(beforeElement);
    const afterId = beforeIndex > 0 ? cards[beforeIndex - 1].dataset.cardId : null;
    return { beforeId, afterId };
  }

  const lastElement = cards[cards.length - 1];
  return { beforeId: null, afterId: lastElement?.dataset.cardId || null };
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  const previous = cloneBoard(board);
  optimisticMove(cardId, columnId, beforeId, afterId);

  try {
    const response = await fetch(`/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId })
    });

    if (!response.ok) throw new Error('Move failed');
    const { card } = await response.json();
    // Apply the canonical card immediately; the following SSE board event will
    // snap the whole board into place, including any renormalized neighbours.
    applyCanonicalCard(card);
  } catch (error) {
    console.error(error);
    setBoard(previous);
    await loadBoard().catch(console.error);
  }
}

async function createCard(columnId, input) {
  const text = input.value.trim();
  if (!text) return;

  input.disabled = true;
  try {
    const response = await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });

    if (!response.ok) throw new Error('Create failed');
    const { card } = await response.json();
    input.value = '';
    applyCanonicalCard(card);
  } catch (error) {
    console.error(error);
    alert('Could not create the card. Please try again.');
  } finally {
    input.disabled = false;
    input.focus();
  }
}

function connectStream() {
  if (stream) stream.close();

  stream = new EventSource('/api/stream');

  stream.addEventListener('board', (event) => {
    setBoard(JSON.parse(event.data));
  });

  stream.addEventListener('mutation', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.card) applyCanonicalCard(payload.card);
  });

  stream.onerror = () => {
    // EventSource reconnects automatically. Fetching the board here makes the UI
    // converge quickly after transient network/server restarts.
    loadBoard().catch(() => {});
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function render() {
  app.innerHTML = `
    <header class="app-header">
      <div>
        <p class="eyebrow">PGLite + SSE</p>
        <h1>Collaborative Kanban Board</h1>
      </div>
      <button class="refresh-button" type="button">Refresh</button>
    </header>
    <main class="board" aria-label="Kanban board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;

  app.querySelector('.refresh-button')?.addEventListener('click', () => loadBoard().catch(console.error));

  for (const form of app.querySelectorAll('.add-card-form')) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      createCard(form.dataset.columnId, form.querySelector('input'));
    });
  }

  for (const card of app.querySelectorAll('.card')) {
    card.addEventListener('dragstart', (event) => {
      draggedCardId = card.dataset.cardId;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
      requestAnimationFrame(() => card.classList.add('dragging'));
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      draggedCardId = null;
      for (const column of app.querySelectorAll('.column')) column.classList.remove('drop-target');
    });
  }

  for (const column of app.querySelectorAll('.column')) {
    const list = column.querySelector('.card-list');

    column.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      column.classList.add('drop-target');
    });

    column.addEventListener('dragleave', (event) => {
      if (!column.contains(event.relatedTarget)) column.classList.remove('drop-target');
    });

    column.addEventListener('drop', (event) => {
      event.preventDefault();
      column.classList.remove('drop-target');
      const cardId = event.dataTransfer.getData('text/plain') || draggedCardId;
      if (!cardId) return;

      const columnId = column.dataset.columnId;
      const { beforeId, afterId } = getDropIntent(list, event.clientY, cardId);
      const current = findCard(cardId);
      if (current?.column.id === columnId && current.column.cards.length === 1) return;

      moveCard(cardId, columnId, beforeId, afterId);
    });
  }
}

function renderColumn(column) {
  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <div class="column-header">
        <h2>${escapeHtml(column.title)}</h2>
        <span class="count">${column.cards.length}</span>
      </div>
      <div class="card-list">
        ${column.cards.map(renderCard).join('') || '<p class="empty">Drop cards here</p>'}
      </div>
      <form class="add-card-form" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card..." aria-label="Add a card to ${escapeHtml(column.title)}" />
        <button type="submit">Add</button>
      </form>
    </section>
  `;
}

function renderCard(card) {
  return `
    <article class="card ${card.optimistic ? 'optimistic' : ''}" draggable="true" data-card-id="${escapeHtml(card.id)}">
      <p>${escapeHtml(card.text)}</p>
      ${card.optimistic ? '<span class="syncing">syncing</span>' : ''}
    </article>
  `;
}

loadBoard().catch((error) => {
  console.error(error);
  app.innerHTML = '<p class="load-error">Could not load the board. Is the backend running?</p>';
});
connectStream();
