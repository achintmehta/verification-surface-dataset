import './styles.css';

const API_BASE = '';
const app = document.querySelector('#app');

let board = { columns: [] };
let draggedCardId = null;
let eventSource = null;

function cardById(cardId) {
  for (const column of board.columns) {
    const found = column.cards.find((card) => card.id === cardId);
    if (found) return found;
  }
  return null;
}

function removeCardEverywhere(cardId) {
  for (const column of board.columns) {
    column.cards = column.cards.filter((card) => card.id !== cardId);
  }
}

function sortCards(column) {
  column.cards.sort((a, b) => (Number(a.position) - Number(b.position)) || a.id.localeCompare(b.id));
}

function applyCanonicalCard(card) {
  const existing = cardById(card.id);
  const canonical = { ...(existing ?? {}), ...card };
  removeCardEverywhere(card.id);

  const targetColumn = board.columns.find((column) => column.id === canonical.columnId);
  if (targetColumn) {
    targetColumn.cards.push(canonical);
    sortCards(targetColumn);
  }
}

async function requestJson(url, options) {
  const response = await fetch(`${API_BASE}${url}`, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
    ...options
  });

  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.error || `Request failed with ${response.status}`);
  }

  return response.json();
}

async function loadBoard() {
  board = await requestJson('/api/board');
  render();
}

function escapeText(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function render() {
  const statusText = eventSource?.readyState === EventSource.OPEN ? 'Live' : 'Connecting…';
  const statusIsError = statusText !== 'Live';

  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. All clients converge through server-sent events.</p>
      </div>
      <span class="status ${statusIsError ? 'error' : ''}" id="connection-status">${statusText}</span>
    </header>
    <main class="board" id="board">
      ${board.columns.map((column) => `
        <section class="column" data-column-id="${column.id}">
          <div class="column-header">
            <h2>${escapeText(column.title)}</h2>
            <span>${column.cards.length}</span>
          </div>
          <form class="new-card-form" data-column-id="${column.id}">
            <input name="text" type="text" placeholder="Add a card…" autocomplete="off" />
            <button type="submit">Add</button>
          </form>
          <div class="card-list" data-column-id="${column.id}">
            ${column.cards.map((card) => `
              <article class="card" draggable="true" data-card-id="${card.id}">
                ${escapeText(card.text)}
              </article>
            `).join('')}
          </div>
        </section>
      `).join('')}
    </main>
  `;

  attachDomHandlers();
}

function setConnectionStatus(text, isError = false) {
  const status = document.querySelector('#connection-status');
  if (!status) return;
  status.textContent = text;
  status.classList.toggle('error', isError);
}

function attachDomHandlers() {
  document.querySelectorAll('.new-card-form').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      if (!text) return;

      input.value = '';
      try {
        const { card } = await requestJson('/api/cards', {
          method: 'POST',
          body: JSON.stringify({ columnId: form.dataset.columnId, text })
        });
        applyCanonicalCard(card);
        render();
      } catch (error) {
        input.value = text;
        alert(error.message);
      }
    });
  });

  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      draggedCardId = cardEl.dataset.cardId;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
      requestAnimationFrame(() => cardEl.classList.add('dragging'));
    });

    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.card-list.drag-over').forEach((list) => list.classList.remove('drag-over'));
      draggedCardId = null;
    });
  });

  document.querySelectorAll('.card-list').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      list.classList.add('drag-over');
      const dragging = document.querySelector('.card.dragging');
      if (!dragging) return;

      const afterElement = getDragAfterElement(list, event.clientY);
      if (afterElement == null) {
        list.appendChild(dragging);
      } else {
        list.insertBefore(dragging, afterElement);
      }
    });

    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) {
        list.classList.remove('drag-over');
      }
    });

    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drag-over');
      const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
      const cardEl = list.querySelector(`[data-card-id="${cardId}"]`);
      if (!cardId || !cardEl) return;

      const previous = cardEl.previousElementSibling;
      const next = cardEl.nextElementSibling;
      const columnId = list.dataset.columnId;
      const beforeId = next?.dataset.cardId ?? null;
      const afterId = previous?.dataset.cardId ?? null;

      applyOptimisticDomOrder(cardId, columnId);

      try {
        const { card } = await requestJson(`/api/cards/${cardId}/move`, {
          method: 'PATCH',
          body: JSON.stringify({ columnId, beforeId, afterId })
        });
        applyCanonicalCard(card);
        render();
      } catch (error) {
        alert(error.message);
        await loadBoard();
      }
    });
  });
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
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

function applyOptimisticDomOrder(cardId, columnId) {
  const card = cardById(cardId);
  if (!card) return;

  const list = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
  const orderedIds = [...list.querySelectorAll('.card')].map((el) => el.dataset.cardId);
  const knownCards = new Map();
  for (const column of board.columns) {
    for (const candidate of column.cards) {
      knownCards.set(candidate.id, candidate);
    }
  }

  removeCardEverywhere(cardId);

  const target = board.columns.find((column) => column.id === columnId);
  if (!target) return;

  const optimisticCards = orderedIds
    .map((id, index) => {
      const existing = id === cardId ? card : knownCards.get(id);
      return existing ? { ...existing, columnId, position: index + 1 } : null;
    })
    .filter(Boolean);

  target.cards = optimisticCards;
}

function connectStream() {
  eventSource = new EventSource('/api/stream');

  eventSource.addEventListener('open', () => setConnectionStatus('Live'));
  eventSource.addEventListener('connected', () => setConnectionStatus('Live'));
  eventSource.addEventListener('error', () => setConnectionStatus('Reconnecting…', true));

  eventSource.addEventListener('create', (event) => {
    const { card } = JSON.parse(event.data);
    applyCanonicalCard(card);
    render();
  });

  eventSource.addEventListener('move', (event) => {
    const { card } = JSON.parse(event.data);
    applyCanonicalCard(card);
    render();
  });

  eventSource.addEventListener('board', (event) => {
    board = JSON.parse(event.data);
    render();
  });
}

await loadBoard();
connectStream();
