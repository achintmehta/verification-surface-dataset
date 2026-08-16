import './styles.css';

const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let draggedFromColumnId = null;
let reconnectNotice = '';

function byPosition(a, b) {
  if (a.position !== b.position) return a.position - b.position;
  return a.id.localeCompare(b.id);
}

async function fetchBoard() {
  const response = await fetch('/api/board');
  if (!response.ok) throw new Error('Failed to load board');
  board = await response.json();
  render();
}

function normalizeIncomingBoard(nextBoard) {
  const seen = new Set();
  return {
    columns: [...(nextBoard.columns ?? [])]
      .sort(byPosition)
      .map((column) => {
        const cards = [];
        for (const card of [...(column.cards ?? [])].sort(byPosition)) {
          if (seen.has(card.id)) continue;
          seen.add(card.id);
          cards.push(card);
        }
        return { ...column, cards };
      }),
  };
}

function setBoard(nextBoard) {
  board = normalizeIncomingBoard(nextBoard);
  render();
}

function findCard(cardId) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index >= 0) return { column, index, card: column.cards[index] };
  }
  return null;
}

function optimisticallyMove(cardId, targetColumnId, beforeId, afterId) {
  const found = findCard(cardId);
  if (!found) return;

  const card = { ...found.card, columnId: targetColumnId, optimistic: true };
  const nextColumns = board.columns.map((column) => ({
    ...column,
    cards: column.cards.filter((candidate) => candidate.id !== cardId),
  }));
  const target = nextColumns.find((column) => column.id === targetColumnId);
  if (!target) return;

  let insertIndex = target.cards.length;
  if (afterId) {
    const afterIndex = target.cards.findIndex((candidate) => candidate.id === afterId);
    if (afterIndex >= 0) insertIndex = afterIndex + 1;
  } else if (beforeId) {
    const beforeIndex = target.cards.findIndex((candidate) => candidate.id === beforeId);
    if (beforeIndex >= 0) insertIndex = beforeIndex;
    else insertIndex = 0;
  }

  target.cards.splice(Math.max(0, Math.min(insertIndex, target.cards.length)), 0, card);
  board = { columns: nextColumns };
  render();
}

function cardElement(card) {
  const el = document.createElement('article');
  el.className = `card${card.optimistic ? ' optimistic' : ''}`;
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.innerHTML = `<p></p><span class="drag-handle" aria-hidden="true">⋮⋮</span>`;
  el.querySelector('p').textContent = card.text;

  el.addEventListener('dragstart', (event) => {
    draggedCardId = card.id;
    draggedFromColumnId = card.columnId;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.id);
    requestAnimationFrame(() => el.classList.add('dragging'));
  });

  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.drop-target').forEach((node) => node.classList.remove('drop-target'));
    draggedCardId = null;
    draggedFromColumnId = null;
  });

  return el;
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];

  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset, element: child };
    }
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

function wireDropZone(columnEl, cardsEl, column) {
  columnEl.addEventListener('dragover', (event) => {
    if (!draggedCardId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    columnEl.classList.add('drop-target');

    const draggedEl = document.querySelector(`[data-card-id="${CSS.escape(draggedCardId)}"]`);
    if (!draggedEl) return;
    const afterElement = getDragAfterElement(cardsEl, event.clientY);
    if (afterElement == null) cardsEl.appendChild(draggedEl);
    else cardsEl.insertBefore(draggedEl, afterElement);
  });

  columnEl.addEventListener('dragleave', (event) => {
    if (!columnEl.contains(event.relatedTarget)) columnEl.classList.remove('drop-target');
  });

  columnEl.addEventListener('drop', async (event) => {
    event.preventDefault();
    columnEl.classList.remove('drop-target');
    const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
    if (!cardId) return;

    const draggedEl = cardsEl.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`);
    if (!draggedEl) return;
    const previous = draggedEl.previousElementSibling;
    const next = draggedEl.nextElementSibling;
    const afterId = previous?.dataset.cardId ?? null;
    const beforeId = next?.dataset.cardId ?? null;

    optimisticallyMove(cardId, column.id, beforeId, afterId);

    try {
      const response = await fetch(`/api/cards/${encodeURIComponent(cardId)}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId: column.id, beforeId, afterId }),
      });
      if (!response.ok) throw new Error(await response.text());
      // The SSE board event is authoritative. No local response merge is needed.
    } catch (err) {
      console.error('Move failed; reloading authoritative board', err);
      await fetchBoard();
    }
  });
}

function columnElement(column) {
  const el = document.createElement('section');
  el.className = 'column';
  el.dataset.columnId = column.id;

  const heading = document.createElement('header');
  heading.className = 'column-header';
  heading.innerHTML = `<h2></h2><span class="count"></span>`;
  heading.querySelector('h2').textContent = column.title;
  heading.querySelector('.count').textContent = String(column.cards.length);

  const cardsEl = document.createElement('div');
  cardsEl.className = 'cards';
  for (const card of column.cards) cardsEl.appendChild(cardElement(card));

  const form = document.createElement('form');
  form.className = 'new-card-form';
  form.innerHTML = `
    <input name="text" type="text" maxlength="300" placeholder="Add a card…" autocomplete="off" />
    <button type="submit">Add</button>
  `;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = form.elements.text;
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    try {
      const response = await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId: column.id, text }),
      });
      if (!response.ok) throw new Error(await response.text());
    } catch (err) {
      console.error('Create failed', err);
      input.value = text;
      alert('Could not create card. Please try again.');
    }
  });

  el.append(heading, cardsEl, form);
  wireDropZone(el, cardsEl, column);
  return el;
}

function render() {
  app.innerHTML = '';

  const shell = document.createElement('main');
  shell.className = 'shell';

  const top = document.createElement('header');
  top.className = 'app-header';
  top.innerHTML = `
    <div>
      <h1>Collaborative Kanban</h1>
      <p>Drag cards between columns. Every change is persisted and broadcast with SSE.</p>
    </div>
    <div class="status ${reconnectNotice ? 'warn' : 'ok'}">${reconnectNotice || 'Live'}</div>
  `;

  const boardEl = document.createElement('div');
  boardEl.className = 'board';
  for (const column of [...board.columns].sort(byPosition)) {
    boardEl.appendChild(columnElement({ ...column, cards: [...column.cards].sort(byPosition) }));
  }

  shell.append(top, boardEl);
  app.appendChild(shell);
}

function connectStream() {
  const source = new EventSource('/api/stream');

  const handlePayload = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'board' && payload.board) {
      reconnectNotice = '';
      setBoard(payload.board);
    }
  };

  source.addEventListener('board', handlePayload);
  source.addEventListener('message', handlePayload);
  source.addEventListener('connected', () => {
    reconnectNotice = '';
    render();
  });
  source.onerror = () => {
    reconnectNotice = 'Reconnecting…';
    render();
  };
}

fetchBoard()
  .then(connectStream)
  .catch((err) => {
    console.error(err);
    app.innerHTML = `<main class="shell"><h1>Could not load board</h1><p>${err.message}</p></main>`;
  });
