import './styles.css';

const boardEl = document.querySelector('#board');
const statusEl = document.querySelector('#connectionStatus');

let board = { columns: [] };
let draggingCardId = null;
const optimisticCards = new Set();

function setStatus(kind, text) {
  statusEl.className = `status status-${kind}`;
  statusEl.textContent = text;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function sortCards(cards) {
  return [...cards].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    if ((a.createdAt || '') !== (b.createdAt || '')) return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    return a.id.localeCompare(b.id);
  });
}

function normalizeBoard(nextBoard) {
  return {
    columns: [...(nextBoard.columns || [])]
      .sort((a, b) => a.position - b.position)
      .map((column) => ({
        ...column,
        cards: sortCards(column.cards || [])
      }))
  };
}

function findCard(cardId) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) return { card: column.cards[index], column, index };
  }
  return null;
}

function renderBoard() {
  boardEl.innerHTML = board.columns.map((column) => `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <div class="column-header">
        <h2 class="column-title">${escapeHtml(column.title)}</h2>
        <span class="count">${column.cards.length}</span>
      </div>
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${column.cards.length === 0 ? '<div class="empty">Drop cards here</div>' : ''}
        ${column.cards.map((card) => `
          <article class="card ${optimisticCards.has(card.id) ? 'optimistic' : ''}" draggable="true" data-card-id="${escapeHtml(card.id)}">
            ${escapeHtml(card.text)}
          </article>
        `).join('')}
      </div>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
    </section>
  `).join('');
}

async function loadBoard() {
  const response = await fetch('/api/board');
  if (!response.ok) throw new Error('Unable to load board');
  board = normalizeBoard(await response.json());
  optimisticCards.clear();
  renderBoard();
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

function insertCardByPosition(card) {
  const column = board.columns.find((item) => item.id === card.columnId);
  if (!column) return;
  column.cards = sortCards([...column.cards.filter((item) => item.id !== card.id), card]);
}

function rememberUnknownCard(card) {
  if (board.columns.some((column) => column.id === card.columnId)) return;
  board.columns.push({
    id: card.columnId,
    title: card.columnId,
    position: board.columns.length ? Math.max(...board.columns.map((column) => column.position)) + 1000 : 1000,
    cards: []
  });
}

function applyCanonicalCard(card) {
  rememberUnknownCard(card);
  removeCardEverywhere(card.id);
  optimisticCards.delete(card.id);
  insertCardByPosition(card);
  renderBoard();
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 2800);
}

function getInsertionIds(listEl, pointerY, draggedCardId = null) {
  const cards = [...listEl.querySelectorAll('.card:not(.dragging)')].filter((cardEl) => cardEl.dataset.cardId !== draggedCardId);
  let beforeEl = null;

  for (const cardEl of cards) {
    const rect = cardEl.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (pointerY < midpoint) {
      beforeEl = cardEl;
      break;
    }
  }

  if (beforeEl) {
    const beforeIndex = cards.indexOf(beforeEl);
    const afterEl = beforeIndex > 0 ? cards[beforeIndex - 1] : null;
    return {
      beforeId: beforeEl.dataset.cardId,
      afterId: afterEl?.dataset.cardId || null
    };
  }

  const afterEl = cards[cards.length - 1] || null;
  return { beforeId: null, afterId: afterEl?.dataset.cardId || null };
}

function optimisticMove(cardId, columnId, beforeId, afterId) {
  const existing = removeCardEverywhere(cardId);
  if (!existing) return;

  const target = board.columns.find((column) => column.id === columnId);
  if (!target) return;

  const moved = { ...existing, columnId };
  const withoutDuplicate = target.cards.filter((card) => card.id !== cardId);
  let index = withoutDuplicate.length;

  if (beforeId) {
    const beforeIndex = withoutDuplicate.findIndex((card) => card.id === beforeId);
    if (beforeIndex !== -1) index = beforeIndex;
  } else if (afterId) {
    const afterIndex = withoutDuplicate.findIndex((card) => card.id === afterId);
    if (afterIndex !== -1) index = afterIndex + 1;
  }

  withoutDuplicate.splice(index, 0, moved);
  target.cards = withoutDuplicate;
  optimisticCards.add(cardId);
  renderBoard();
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  optimisticMove(cardId, columnId, beforeId, afterId);

  try {
    const response = await fetch(`/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId })
    });

    if (!response.ok) throw new Error('Move rejected');
    const { card } = await response.json();
    applyCanonicalCard(card);
  } catch (error) {
    console.error(error);
    showToast('Move failed; reloading server state');
    await loadBoard();
  }
}

boardEl.addEventListener('submit', async (event) => {
  const form = event.target.closest('.add-card');
  if (!form) return;
  event.preventDefault();

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
    if (!response.ok) throw new Error('Create rejected');
    const { card } = await response.json();
    applyCanonicalCard(card);
  } catch (error) {
    console.error(error);
    showToast('Could not create card');
    input.value = text;
  }
});

boardEl.addEventListener('dragstart', (event) => {
  const cardEl = event.target.closest('.card');
  if (!cardEl) return;
  draggingCardId = cardEl.dataset.cardId;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggingCardId);
  requestAnimationFrame(() => cardEl.classList.add('dragging'));
});

boardEl.addEventListener('dragend', () => {
  draggingCardId = null;
  document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
});

boardEl.addEventListener('dragover', (event) => {
  const listEl = event.target.closest('.cards');
  if (!listEl || !draggingCardId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  listEl.classList.add('drag-over');
});

boardEl.addEventListener('dragleave', (event) => {
  const listEl = event.target.closest('.cards');
  if (!listEl || listEl.contains(event.relatedTarget)) return;
  listEl.classList.remove('drag-over');
});

boardEl.addEventListener('drop', (event) => {
  const listEl = event.target.closest('.cards');
  if (!listEl) return;
  event.preventDefault();
  listEl.classList.remove('drag-over');

  const cardId = draggingCardId || event.dataTransfer.getData('text/plain');
  if (!cardId) return;

  const columnId = listEl.dataset.columnId;
  const { beforeId, afterId } = getInsertionIds(listEl, event.clientY, cardId);
  moveCard(cardId, columnId, beforeId, afterId);
});

function connectStream() {
  setStatus('connecting', 'Connecting…');
  const stream = new EventSource('/api/stream');

  stream.addEventListener('open', () => setStatus('connected', 'Live'));
  stream.addEventListener('connected', () => setStatus('connected', 'Live'));

  stream.addEventListener('board', (event) => {
    board = normalizeBoard(JSON.parse(event.data));
    optimisticCards.clear();
    renderBoard();
  });

  stream.addEventListener('create', (event) => {
    const { card } = JSON.parse(event.data);
    applyCanonicalCard(card);
  });

  stream.addEventListener('move', (event) => {
    const { card } = JSON.parse(event.data);
    applyCanonicalCard(card);
  });

  stream.addEventListener('error', () => {
    setStatus('error', 'Reconnecting…');
  });
}

loadBoard()
  .then(connectStream)
  .catch((error) => {
    console.error(error);
    setStatus('error', 'Load failed');
    boardEl.innerHTML = '<p class="empty">Could not load the board. Is the server running?</p>';
  });
