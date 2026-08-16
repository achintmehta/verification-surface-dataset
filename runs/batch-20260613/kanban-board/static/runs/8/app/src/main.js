import './styles.css';

const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let eventSource;

const stateByCardId = () => {
  const map = new Map();
  for (const column of board.columns) {
    for (const card of column.cards) {
      map.set(card.id, { card, column });
    }
  }
  return map;
};

const sortBoard = () => {
  board.columns.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  for (const column of board.columns) {
    column.cards.sort(
      (a, b) =>
        a.position - b.position ||
        String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
        a.id.localeCompare(b.id)
    );
  }
};

const setStatus = (message, tone = 'neutral') => {
  const status = document.querySelector('[data-status]');
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
};

const replaceBoard = (nextBoard) => {
  board = {
    columns: (nextBoard?.columns || []).map((column) => ({
      ...column,
      position: Number(column.position),
      cards: (column.cards || []).map((card) => ({
        ...card,
        columnId: card.columnId,
        position: Number(card.position)
      }))
    }))
  };
  sortBoard();
  render();
};

const findColumn = (columnId) => board.columns.find((column) => column.id === columnId);

const removeCardLocally = (cardId) => {
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) {
      return column.cards.splice(index, 1)[0];
    }
  }
  return null;
};

const optimisticMove = (cardId, columnId, beforeId, afterId) => {
  const targetColumn = findColumn(columnId);
  if (!targetColumn) return;

  const card = removeCardLocally(cardId);
  if (!card) return;

  card.columnId = columnId;

  const beforeIndex = beforeId ? targetColumn.cards.findIndex((item) => item.id === beforeId) : -1;
  const afterIndex = afterId ? targetColumn.cards.findIndex((item) => item.id === afterId) : -1;
  let index = targetColumn.cards.length;

  if (afterIndex !== -1) index = afterIndex + 1;
  else if (beforeIndex !== -1) index = beforeIndex;

  targetColumn.cards.splice(index, 0, card);

  const previous = targetColumn.cards[index - 1];
  const next = targetColumn.cards[index + 1];
  if (previous && next) card.position = previous.position + (next.position - previous.position) / 2;
  else if (previous) card.position = previous.position + 1000;
  else if (next) card.position = next.position - 1000;
  else card.position = 1000;

  render();
};

const getDropIntent = (list, clientY) => {
  const cards = [...list.querySelectorAll('.card:not(.dragging)')];
  let beforeId = null;
  let afterId = null;

  for (const cardElement of cards) {
    const rect = cardElement.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      beforeId = cardElement.dataset.cardId;
      break;
    }
    afterId = cardElement.dataset.cardId;
  }

  return { beforeId, afterId };
};

const moveCardOnServer = async (cardId, columnId, beforeId, afterId) => {
  const response = await fetch(`/api/cards/${encodeURIComponent(cardId)}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId, beforeId, afterId })
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || 'Unable to move card');
  }

  return response.json();
};

const createCard = async (columnId, form) => {
  const input = form.querySelector('input');
  const text = input.value.trim();
  if (!text) return;

  input.disabled = true;
  form.querySelector('button').disabled = true;

  try {
    const response = await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || 'Unable to create card');
    }

    input.value = '';
    setStatus('Card created', 'ok');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    input.disabled = false;
    form.querySelector('button').disabled = false;
    input.focus();
  }
};

const cardTemplate = (card) => `
  <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}">
    <p>${escapeHtml(card.text)}</p>
  </article>
`;

const columnTemplate = (column) => `
  <section class="column" data-column-id="${escapeHtml(column.id)}">
    <header class="column__header">
      <h2>${escapeHtml(column.title)}</h2>
      <span>${column.cards.length}</span>
    </header>
    <div class="card-list" data-card-list data-column-id="${escapeHtml(column.id)}">
      ${column.cards.map(cardTemplate).join('')}
    </div>
    <form class="add-card" data-add-card>
      <input type="text" name="text" maxlength="500" placeholder="Add a card..." aria-label="New card for ${escapeHtml(column.title)}" />
      <button type="submit">Add</button>
    </form>
  </section>
`;

function render() {
  app.innerHTML = `
    <main class="shell">
      <header class="app-header">
        <div>
          <p class="eyebrow">PGLite + SSE</p>
          <h1>Collaborative Kanban Board</h1>
        </div>
        <p class="status" data-status data-tone="neutral">Connected clients converge on the server order.</p>
      </header>
      <div class="board" data-board>
        ${board.columns.map(columnTemplate).join('')}
      </div>
    </main>
  `;

  bindDomEvents();
}

function bindDomEvents() {
  for (const card of document.querySelectorAll('.card')) {
    card.addEventListener('dragstart', (event) => {
      draggedCardId = card.dataset.cardId;
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
    });

    card.addEventListener('dragend', () => {
      draggedCardId = null;
      card.classList.remove('dragging');
      document.querySelectorAll('.card-list.is-over').forEach((list) => list.classList.remove('is-over'));
    });
  }

  for (const list of document.querySelectorAll('[data-card-list]')) {
    list.addEventListener('dragover', (event) => {
      if (!draggedCardId) return;
      event.preventDefault();
      list.classList.add('is-over');
      event.dataTransfer.dropEffect = 'move';
    });

    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) list.classList.remove('is-over');
    });

    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('is-over');

      const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
      if (!cardId) return;

      const columnId = list.dataset.columnId;
      const originalBoard = structuredClone(board);
      const { beforeId, afterId } = getDropIntent(list, event.clientY);

      optimisticMove(cardId, columnId, beforeId, afterId);
      setStatus('Saving move...', 'neutral');

      try {
        await moveCardOnServer(cardId, columnId, beforeId, afterId);
        setStatus('Move saved', 'ok');
      } catch (error) {
        replaceBoard(originalBoard);
        setStatus(error.message, 'error');
        await loadBoard();
      }
    });
  }

  for (const form of document.querySelectorAll('[data-add-card]')) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const column = form.closest('[data-column-id]');
      createCard(column.dataset.columnId, form);
    });
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

const loadBoard = async () => {
  const response = await fetch('/api/board');
  if (!response.ok) throw new Error('Unable to load board');
  replaceBoard(await response.json());
};

const connectStream = () => {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/stream');

  eventSource.addEventListener('connected', () => {
    setStatus('Realtime stream connected', 'ok');
  });

  eventSource.addEventListener('board', (event) => {
    const payload = JSON.parse(event.data);
    replaceBoard(payload.board);
    if (payload.kind === 'card-created') setStatus('A card was created', 'ok');
    else if (payload.kind === 'card-moved') setStatus('Board reconciled to canonical order', 'ok');
  });

  eventSource.onerror = () => {
    setStatus('Realtime stream disconnected; retrying...', 'error');
  };
};

const bootstrap = async () => {
  app.innerHTML = '<main class="shell"><p class="loading">Loading board...</p></main>';
  try {
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = `<main class="shell"><p class="error">${escapeHtml(error.message)}</p></main>`;
  }
};

bootstrap();
