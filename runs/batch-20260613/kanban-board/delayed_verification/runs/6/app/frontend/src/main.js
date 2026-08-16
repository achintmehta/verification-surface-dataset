import './styles.css';

const boardEl = document.querySelector('#board');
const statusEl = document.querySelector('#connection-status');

let state = { columns: [] };
let draggedCardId = null;
let dragOrigin = null;

const api = {
  async board() {
    const res = await fetch('/api/board');
    if (!res.ok) throw new Error('Failed to load board');
    return res.json();
  },
  async createCard(columnId, text) {
    const res = await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to create card');
    return res.json();
  },
  async moveCard(cardId, intent) {
    const res = await fetch(`/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intent)
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to move card');
    return res.json();
  }
};

function setStatus(text, kind = 'ok') {
  statusEl.textContent = text;
  statusEl.className = `status status-${kind}`;
}

function sortCards(cards) {
  return [...cards].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    if ((a.createdAt || '') !== (b.createdAt || '')) return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    return a.id.localeCompare(b.id);
  });
}

function normalizeBoard(board) {
  return {
    columns: [...(board.columns || [])]
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map((column) => ({ ...column, cards: sortCards(column.cards || []) }))
  };
}

function findColumn(columnId) {
  return state.columns.find((column) => column.id === columnId);
}

function findCard(cardId) {
  for (const column of state.columns) {
    const card = column.cards.find((candidate) => candidate.id === cardId);
    if (card) return { card, column };
  }
  return null;
}

function removeCardEverywhere(cardId) {
  for (const column of state.columns) {
    column.cards = column.cards.filter((card) => card.id !== cardId);
  }
}

function applyCanonicalCard(card) {
  removeCardEverywhere(card.id);
  const target = findColumn(card.columnId);
  if (!target) return;
  target.cards.push(card);
  target.cards = sortCards(target.cards);
  render();
}

function getCardElement(cardId) {
  if (!cardId) return null;
  return boardEl.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`);
}

function render() {
  boardEl.innerHTML = '';

  for (const column of state.columns) {
    const columnEl = document.createElement('article');
    columnEl.className = 'column';
    columnEl.dataset.columnId = column.id;

    const header = document.createElement('div');
    header.className = 'column-header';
    const title = document.createElement('h2');
    title.textContent = column.title;
    const count = document.createElement('span');
    count.textContent = String(column.cards.length);
    header.append(title, count);

    const cardsEl = document.createElement('div');
    cardsEl.className = 'cards';
    cardsEl.dataset.columnId = column.id;
    cardsEl.addEventListener('dragover', onDragOver);
    cardsEl.addEventListener('drop', onDrop);
    cardsEl.addEventListener('dragleave', (event) => {
      if (!cardsEl.contains(event.relatedTarget)) cardsEl.classList.remove('drag-over');
    });

    for (const card of column.cards) {
      cardsEl.appendChild(renderCard(card));
    }

    const form = document.createElement('form');
    form.className = 'new-card-form';
    const textarea = document.createElement('textarea');
    textarea.rows = 2;
    textarea.placeholder = 'Add a card…';
    textarea.setAttribute('aria-label', `New card text for ${column.title}`);
    const button = document.createElement('button');
    button.type = 'submit';
    button.textContent = 'Add Card';
    form.append(textarea, button);
    form.addEventListener('submit', (event) => onCreateCard(event, column.id));

    columnEl.append(header, cardsEl, form);
    boardEl.appendChild(columnEl);
  }
}

function renderCard(card) {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.draggable = true;
  cardEl.dataset.cardId = card.id;
  const text = document.createElement('p');
  text.textContent = card.text;
  cardEl.appendChild(text);
  cardEl.addEventListener('dragstart', onDragStart);
  cardEl.addEventListener('dragend', onDragEnd);
  return cardEl;
}

async function onCreateCard(event, columnId) {
  event.preventDefault();
  const textarea = event.currentTarget.querySelector('textarea');
  const text = textarea.value.trim();
  if (!text) return;

  textarea.value = '';
  try {
    await api.createCard(columnId, text);
    // The SSE broadcast is authoritative and will insert/reorder the card on all
    // clients, including this one.
  } catch (error) {
    textarea.value = text;
    setStatus(error.message, 'bad');
  }
}

function onDragStart(event) {
  const cardEl = event.currentTarget;
  draggedCardId = cardEl.dataset.cardId;
  const located = findCard(draggedCardId);
  dragOrigin = located ? { columnId: located.column.id, cards: [...located.column.cards] } : null;
  cardEl.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedCardId);
}

function onDragEnd(event) {
  event.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.cards.drag-over').forEach((el) => el.classList.remove('drag-over'));
  draggedCardId = null;
  dragOrigin = null;
}

function onDragOver(event) {
  event.preventDefault();
  const cardsEl = event.currentTarget;
  cardsEl.classList.add('drag-over');
  const draggingEl = getCardElement(draggedCardId);
  if (!draggingEl) return;

  const beforeEl = getCardBeforePointer(cardsEl, event.clientY);
  if (beforeEl) cardsEl.insertBefore(draggingEl, beforeEl);
  else cardsEl.appendChild(draggingEl);
}

async function onDrop(event) {
  event.preventDefault();
  const cardsEl = event.currentTarget;
  cardsEl.classList.remove('drag-over');

  const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
  if (!cardId) return;

  const columnId = cardsEl.dataset.columnId;
  const beforeEl = getNextCardElement(cardsEl, cardId);
  const afterEl = getPreviousCardElement(cardsEl, cardId);
  const intent = {
    columnId,
    beforeId: beforeEl?.dataset.cardId || null,
    afterId: afterEl?.dataset.cardId || null
  };

  optimisticMove(cardId, columnId, intent.beforeId, intent.afterId);

  try {
    await api.moveCard(cardId, intent);
    // The SSE broadcast carries the canonical server position and reconciles the
    // optimistic DOM/state.
  } catch (error) {
    setStatus(error.message, 'bad');
    if (dragOrigin) {
      const origin = findColumn(dragOrigin.columnId);
      if (origin) origin.cards = dragOrigin.cards;
      await reloadBoard();
    }
  }
}

function getCardBeforePointer(cardsEl, y) {
  const candidates = [...cardsEl.querySelectorAll('.card:not(.dragging)')];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };

  for (const child of candidates) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: child };
  }
  return closest.element;
}

function getPreviousCardElement(cardsEl, cardId) {
  const cards = [...cardsEl.querySelectorAll('.card')];
  const index = cards.findIndex((el) => el.dataset.cardId === cardId);
  for (let i = index - 1; i >= 0; i -= 1) {
    if (cards[i].dataset.cardId !== cardId) return cards[i];
  }
  return null;
}

function getNextCardElement(cardsEl, cardId) {
  const cards = [...cardsEl.querySelectorAll('.card')];
  const index = cards.findIndex((el) => el.dataset.cardId === cardId);
  for (let i = index + 1; i < cards.length; i += 1) {
    if (cards[i].dataset.cardId !== cardId) return cards[i];
  }
  return null;
}

function optimisticMove(cardId, columnId, beforeId, afterId) {
  const located = findCard(cardId);
  if (!located) return;
  const card = { ...located.card, columnId };

  removeCardEverywhere(cardId);
  const target = findColumn(columnId);
  if (!target) return;

  let insertIndex = target.cards.length;
  if (beforeId) {
    const beforeIndex = target.cards.findIndex((candidate) => candidate.id === beforeId);
    if (beforeIndex >= 0) insertIndex = beforeIndex;
  } else if (afterId) {
    const afterIndex = target.cards.findIndex((candidate) => candidate.id === afterId);
    if (afterIndex >= 0) insertIndex = afterIndex + 1;
  }

  target.cards.splice(insertIndex, 0, card);
  render();
}

async function reloadBoard() {
  state = normalizeBoard(await api.board());
  render();
}

function connectStream() {
  const stream = new EventSource('/api/stream');

  stream.addEventListener('open', () => setStatus('Live', 'ok'));
  stream.addEventListener('error', () => setStatus('Reconnecting…', 'warn'));
  stream.addEventListener('connected', () => setStatus('Live', 'ok'));

  stream.addEventListener('board', (event) => {
    state = normalizeBoard(JSON.parse(event.data));
    render();
  });

  const onCardEvent = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.card) applyCanonicalCard(payload.card);
  };
  stream.addEventListener('create', onCardEvent);
  stream.addEventListener('move', onCardEvent);
}

reloadBoard()
  .catch((error) => setStatus(error.message, 'bad'))
  .finally(connectStream);
