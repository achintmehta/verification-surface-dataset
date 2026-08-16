import './styles.css';

const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let pendingMoves = new Set();
let stream = null;

const api = {
  async board() {
    const response = await fetch('/api/board');
    if (!response.ok) throw new Error('Failed to load board');
    return response.json();
  },
  async createCard(columnId, text) {
    const response = await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Failed to create card');
    return response.json();
  },
  async moveCard(cardId, columnId, beforeId, afterId) {
    const response = await fetch(`/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Failed to move card');
    return response.json();
  }
};

function setStatus(message, tone = 'neutral') {
  const status = document.querySelector('[data-status]');
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
}

function normalizeBoard(nextBoard) {
  const seen = new Set();
  return {
    columns: [...(nextBoard?.columns ?? [])]
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map((column) => {
        const cards = [...(column.cards ?? [])]
          .sort((a, b) => a.position - b.position || String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id))
          .filter((card) => {
            if (seen.has(card.id)) return false;
            seen.add(card.id);
            return true;
          })
          .map((card) => ({ ...card, columnId: column.id }));
        return { ...column, cards };
      })
  };
}

function applyCanonicalBoard(nextBoard) {
  board = normalizeBoard(nextBoard);
  for (const column of board.columns) {
    for (const card of column.cards) pendingMoves.delete(card.id);
  }
  render();
}

function findCard(cardId) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) return { column, card: column.cards[index], index };
  }
  return null;
}

function moveCardInLocalState(cardId, targetColumnId, beforeId) {
  const found = findCard(cardId);
  if (!found) return false;

  const movingCard = { ...found.card, columnId: targetColumnId };
  for (const column of board.columns) {
    column.cards = column.cards.filter((card) => card.id !== cardId);
  }

  const targetColumn = board.columns.find((column) => column.id === targetColumnId);
  if (!targetColumn) return false;

  const beforeIndex = beforeId ? targetColumn.cards.findIndex((card) => card.id === beforeId) : -1;
  const insertAt = beforeIndex >= 0 ? beforeIndex : targetColumn.cards.length;
  targetColumn.cards.splice(insertAt, 0, movingCard);

  // The server is authoritative; this temporary position only keeps rendering
  // stable until the canonical SSE/HTTP response arrives.
  targetColumn.cards.forEach((card, index) => {
    card.position = (index + 1) * 1000;
  });
  return true;
}

function computeDropIntent(columnEl, clientY) {
  const cards = [...columnEl.querySelectorAll('.card:not(.dragging)')];
  const beforeEl = cards.find((cardEl) => {
    const box = cardEl.getBoundingClientRect();
    return clientY < box.top + box.height / 2;
  });

  const beforeId = beforeEl?.dataset.cardId ?? null;
  let afterId = null;
  if (beforeEl) {
    const index = cards.indexOf(beforeEl);
    afterId = index > 0 ? cards[index - 1].dataset.cardId : null;
  } else {
    afterId = cards.length ? cards[cards.length - 1].dataset.cardId : null;
  }

  return { beforeId, afterId };
}

function render() {
  app.innerHTML = `
    <header class="app-header">
      <div>
        <p class="eyebrow">PGLite + SSE</p>
        <h1>Collaborative Kanban Board</h1>
      </div>
      <div class="connection" data-status data-tone="neutral">Connecting…</div>
    </header>
    <main class="board" data-board></main>
  `;

  const boardEl = app.querySelector('[data-board]');

  for (const column of board.columns) {
    const columnEl = document.createElement('section');
    columnEl.className = 'column';
    columnEl.dataset.columnId = column.id;
    columnEl.innerHTML = `
      <div class="column-header">
        <h2>${escapeHtml(column.title)}</h2>
        <span>${column.cards.length}</span>
      </div>
      <div class="cards" data-card-list></div>
      <form class="add-card-form" data-add-card>
        <input name="text" type="text" maxlength="280" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
    `;

    const listEl = columnEl.querySelector('[data-card-list]');
    for (const card of column.cards) {
      const cardEl = document.createElement('article');
      cardEl.className = 'card';
      if (pendingMoves.has(card.id)) cardEl.classList.add('pending');
      cardEl.draggable = true;
      cardEl.dataset.cardId = card.id;
      cardEl.innerHTML = `
        <p>${escapeHtml(card.text)}</p>
        <small>${pendingMoves.has(card.id) ? 'Syncing…' : 'Synced'}</small>
      `;
      listEl.appendChild(cardEl);
    }

    boardEl.appendChild(columnEl);
  }

  bindEvents();
  const isOpen = typeof EventSource !== 'undefined' && stream?.readyState === EventSource.OPEN;
  setStatus(isOpen ? 'Live' : 'Connecting…', isOpen ? 'good' : 'neutral');
}

function bindEvents() {
  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      draggedCardId = cardEl.dataset.cardId;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
      requestAnimationFrame(() => cardEl.classList.add('dragging'));
    });

    cardEl.addEventListener('dragend', () => {
      draggedCardId = null;
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.cards').forEach((list) => list.classList.remove('drag-over'));
    });
  });

  document.querySelectorAll('.column').forEach((columnEl) => {
    const listEl = columnEl.querySelector('[data-card-list]');

    listEl.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      listEl.classList.add('drag-over');
    });

    listEl.addEventListener('dragleave', (event) => {
      if (!listEl.contains(event.relatedTarget)) listEl.classList.remove('drag-over');
    });

    listEl.addEventListener('drop', async (event) => {
      event.preventDefault();
      listEl.classList.remove('drag-over');

      const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
      const targetColumnId = columnEl.dataset.columnId;
      if (!cardId || !targetColumnId) return;

      const { beforeId, afterId } = computeDropIntent(listEl, event.clientY);
      pendingMoves.add(cardId);

      if (moveCardInLocalState(cardId, targetColumnId, beforeId)) {
        render();
      }

      try {
        const payload = await api.moveCard(cardId, targetColumnId, beforeId, afterId);
        if (payload.board) applyCanonicalBoard(payload.board);
        setStatus('Live', 'good');
      } catch (error) {
        console.error(error);
        pendingMoves.delete(cardId);
        setStatus(error.message, 'bad');
        try {
          applyCanonicalBoard(await api.board());
        } catch (reloadError) {
          console.error(reloadError);
        }
      }
    });
  });

  document.querySelectorAll('[data-add-card]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      const columnId = form.closest('.column').dataset.columnId;
      if (!text) return;

      input.value = '';
      input.disabled = true;
      try {
        const payload = await api.createCard(columnId, text);
        if (payload.board) applyCanonicalBoard(payload.board);
        setStatus('Live', 'good');
      } catch (error) {
        console.error(error);
        input.value = text;
        setStatus(error.message, 'bad');
      } finally {
        input.disabled = false;
        input.focus();
      }
    });
  });
}

function connectStream() {
  stream?.close();
  stream = new EventSource('/api/stream');

  stream.addEventListener('open', () => setStatus('Live', 'good'));
  stream.addEventListener('error', () => setStatus('Reconnecting…', 'bad'));

  const applyEvent = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.board) applyCanonicalBoard(payload.board);
      else if (payload.columns) applyCanonicalBoard(payload);
      setStatus('Live', 'good');
    } catch (error) {
      console.error('Invalid SSE payload', error);
    }
  };

  stream.addEventListener('board', applyEvent);
  stream.addEventListener('create', applyEvent);
  stream.addEventListener('move', applyEvent);
  stream.addEventListener('renormalize', applyEvent);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function start() {
  app.innerHTML = '<div class="loading">Loading board…</div>';
  try {
    applyCanonicalBoard(await api.board());
    connectStream();
  } catch (error) {
    console.error(error);
    app.innerHTML = `
      <div class="fatal">
        <h1>Could not load board</h1>
        <p>${escapeHtml(error.message)}</p>
        <button onclick="location.reload()">Reload</button>
      </div>
    `;
  }
}

start();
