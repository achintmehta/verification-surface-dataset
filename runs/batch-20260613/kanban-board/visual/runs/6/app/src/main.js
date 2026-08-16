import './styles.css';

const API_BASE = '';
const state = {
  board: { columns: [] },
  draggingCardId: null,
  dragOriginColumnId: null,
  stream: null,
  status: 'Connecting...'
};

const app = document.querySelector('#app');

function byPosition(a, b) {
  return (Number(a.position) - Number(b.position)) || String(a.id).localeCompare(String(b.id));
}

function normalizeBoard(board) {
  const seen = new Set();
  const columns = [...(board.columns || [])].sort(byPosition).map((column) => {
    const cards = [];
    for (const card of [...(column.cards || [])].sort(byPosition)) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      cards.push({ ...card, columnId: card.columnId || column.id });
    }
    return { ...column, cards };
  });
  return { columns };
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      message = payload.error || message;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

async function loadBoard() {
  const board = await request('/api/board');
  state.board = normalizeBoard(board);
  render();
}

function setStatus(message) {
  state.status = message;
  const status = document.querySelector('[data-status]');
  if (status) status.textContent = message;
}

function findCard(cardId) {
  for (const column of state.board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) return { column, card: column.cards[index], index };
  }
  return null;
}

function removeCardEverywhere(cardId) {
  let removed = null;
  for (const column of state.board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) {
      const [card] = column.cards.splice(index, 1);
      removed = card;
    }
  }
  return removed;
}

function insertCard(card, columnId, beforeId = null) {
  const column = state.board.columns.find((entry) => entry.id === columnId);
  if (!column) return;
  const cleanCard = { ...card, columnId };
  removeCardEverywhere(cleanCard.id);
  const beforeIndex = beforeId ? column.cards.findIndex((entry) => entry.id === beforeId) : -1;
  if (beforeIndex === -1) column.cards.push(cleanCard);
  else column.cards.splice(beforeIndex, 0, cleanCard);
}

function optimisticMove(cardId, columnId, beforeId = null) {
  const card = removeCardEverywhere(cardId);
  if (!card) return;
  insertCard({ ...card, columnId, optimistic: true }, columnId, beforeId);
  render();
}

function neighborIntent(columnId, cardId) {
  const column = state.board.columns.find((entry) => entry.id === columnId);
  if (!column) return { beforeId: null, afterId: null };
  const index = column.cards.findIndex((card) => card.id === cardId);
  if (index === -1) return { beforeId: null, afterId: null };
  return {
    afterId: index > 0 ? column.cards[index - 1].id : null,
    beforeId: index < column.cards.length - 1 ? column.cards[index + 1].id : null
  };
}

function getDragAfterElement(container, y) {
  const cards = [...container.querySelectorAll('.card:not(.dragging)')];
  return cards.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

async function createCard(event, columnId) {
  event.preventDefault();
  const input = event.currentTarget.querySelector('input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    setStatus('Creating card...');
    await request('/api/cards', {
      method: 'POST',
      body: JSON.stringify({ columnId, text })
    });
    setStatus('Live');
  } catch (error) {
    input.value = text;
    setStatus(`Create failed: ${error.message}`);
    await loadBoard();
  }
}

async function persistMove(cardId, columnId) {
  const { beforeId, afterId } = neighborIntent(columnId, cardId);
  try {
    setStatus('Saving move...');
    const payload = await request(`/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      body: JSON.stringify({ columnId, beforeId, afterId })
    });
    if (payload.board) {
      state.board = normalizeBoard(payload.board);
      render();
    }
    setStatus('Live');
  } catch (error) {
    setStatus(`Move failed: ${error.message}`);
    await loadBoard();
  }
}

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Changes sync to every open client via SSE.</p>
      </div>
      <div class="status"><span class="pulse"></span><span data-status>${state.status}</span></div>
    </header>
    <main class="board" aria-label="Kanban board">
      ${state.board.columns.map(renderColumn).join('')}
    </main>
  `;

  for (const form of app.querySelectorAll('[data-create-form]')) {
    form.addEventListener('submit', (event) => createCard(event, form.dataset.columnId));
  }

  for (const card of app.querySelectorAll('.card')) {
    card.addEventListener('dragstart', () => {
      state.draggingCardId = card.dataset.cardId;
      state.dragOriginColumnId = card.dataset.columnId;
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
    });
  }

  for (const list of app.querySelectorAll('.card-list')) {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      const dragging = document.querySelector('.dragging');
      if (!dragging) return;
      const afterElement = getDragAfterElement(list, event.clientY);
      if (afterElement == null) list.appendChild(dragging);
      else list.insertBefore(dragging, afterElement);
    });

    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      const cardId = state.draggingCardId;
      if (!cardId) return;
      const droppedColumnId = list.dataset.columnId;
      const beforeEl = getDragAfterElement(list, event.clientY);
      const beforeId = beforeEl?.dataset.cardId || null;
      state.draggingCardId = null;
      state.dragOriginColumnId = null;
      optimisticMove(cardId, droppedColumnId, beforeId);
      await persistMove(cardId, droppedColumnId);
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

function renderColumn(column) {
  const cards = [...column.cards].sort(byPosition);
  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <div class="column-header">
        <h2>${escapeHtml(column.title)}</h2>
        <span>${cards.length}</span>
      </div>
      <div class="card-list" data-column-id="${escapeHtml(column.id)}">
        ${cards.map((card) => renderCard(card, column.id)).join('')}
      </div>
      <form class="new-card" data-create-form data-column-id="${escapeHtml(column.id)}">
        <input name="text" maxlength="240" placeholder="Add a card..." autocomplete="off" />
        <button type="submit">Add</button>
      </form>
    </section>
  `;
}

function renderCard(card, columnId) {
  return `
    <article class="card${card.optimistic ? ' optimistic' : ''}" draggable="true" data-card-id="${escapeHtml(card.id)}" data-column-id="${escapeHtml(columnId)}">
      <div class="grab" aria-hidden="true">⋮⋮</div>
      <p>${escapeHtml(card.text)}</p>
    </article>
  `;
}

function connectStream() {
  if (state.stream) state.stream.close();
  const stream = new EventSource('/api/stream');
  state.stream = stream;

  stream.addEventListener('open', () => setStatus('Live'));
  stream.addEventListener('connected', () => setStatus('Live'));
  stream.addEventListener('mutation', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.board) {
        state.board = normalizeBoard(payload.board);
      } else if (payload.card) {
        removeCardEverywhere(payload.card.id);
        const target = state.board.columns.find((column) => column.id === payload.columnId);
        if (target) target.cards.push(payload.card);
        for (const column of state.board.columns) column.cards.sort(byPosition);
      }
      render();
      setStatus('Live');
    } catch (error) {
      console.error('Bad SSE payload', error);
      setStatus('Stream payload error');
    }
  });
  stream.addEventListener('error', () => setStatus('Reconnecting...'));
}

app.innerHTML = '<div class="loading">Loading board...</div>';
loadBoard()
  .then(connectStream)
  .catch((error) => {
    app.innerHTML = `<div class="loading error">Failed to load board: ${escapeHtml(error.message)}</div>`;
  });
