import { fetchBoard, createCard, moveCard, openEventStream } from './api.js';
import { createStore } from './state.js';
import { initRenderer, renderBoard, upsertCardEl, replaceColumnCardsEl } from './render.js';
import { initDragAndDrop } from './dnd.js';

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('connection-status');

let store = null;

/* ------------------------------------------------------------------ */
/*  Bootstrap                                                            */
/* ------------------------------------------------------------------ */
async function init() {
  try {
    const data = await fetchBoard();
    store = createStore(data);

    initRenderer(boardEl, handleAddCard);
    renderBoard(store.getColumns());

    initDragAndDrop(boardEl);
    boardEl.addEventListener('card-drop', handleCardDrop);

    connectSSE();
  } catch (err) {
    boardEl.innerHTML = `<div class="board-loading" style="color:#de350b">
      Failed to load board: ${err.message}
    </div>`;
    console.error('[init]', err);
  }
}

/* ------------------------------------------------------------------ */
/*  Add card                                                             */
/* ------------------------------------------------------------------ */
async function handleAddCard(columnId, text) {
  try {
    // Optimistic: the SSE broadcast will confirm and reconcile
    await createCard(columnId, text);
    // The SSE 'card:created' event will update the DOM
  } catch (err) {
    console.error('[handleAddCard]', err);
    alert(`Failed to create card: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Drag-and-drop handler                                               */
/* ------------------------------------------------------------------ */
async function handleCardDrop(e) {
  const { cardId, targetColumnId, beforeId, afterId } = e.detail;

  // Optimistic update
  const optimisticCard = store.optimisticMove(cardId, targetColumnId, beforeId, afterId);
  if (optimisticCard) {
    upsertCardEl(optimisticCard);
  }

  try {
    // Send to server; SSE will broadcast canonical state
    await moveCard(cardId, targetColumnId, beforeId, afterId);
    // The SSE 'card:moved' event will reconcile if needed
  } catch (err) {
    console.error('[handleCardDrop]', err);
    // On error, re-fetch and re-render to restore consistent state
    try {
      const data = await fetchBoard();
      store = createStore(data);
      renderBoard(store.getColumns());
    } catch (fetchErr) {
      console.error('[handleCardDrop] re-fetch failed', fetchErr);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  SSE                                                                  */
/* ------------------------------------------------------------------ */
function connectSSE() {
  const es = openEventStream();

  es.addEventListener('connected', () => {
    setStatus('connected', '🟢 Connected');
  });

  es.addEventListener('card:created', (e) => {
    const { card } = JSON.parse(e.data);
    store.upsertCard(card);
    upsertCardEl(card);
  });

  es.addEventListener('card:moved', (e) => {
    const { card } = JSON.parse(e.data);
    store.upsertCard(card);
    upsertCardEl(card);
  });

  es.addEventListener('column:reordered', (e) => {
    const { columnId, cards } = JSON.parse(e.data);
    store.replaceColumnCards(columnId, cards);
    replaceColumnCardsEl(columnId, cards);
  });

  es.onerror = () => {
    setStatus('error', '🔴 Disconnected – retrying…');
    // EventSource auto-reconnects; update status on next 'connected' event
  };

  es.onopen = () => {
    setStatus('connected', '🟢 Connected');
  };
}

function setStatus(cls, text) {
  statusEl.className = `connection-status ${cls}`;
  statusEl.textContent = text;
}

/* ------------------------------------------------------------------ */
init();
