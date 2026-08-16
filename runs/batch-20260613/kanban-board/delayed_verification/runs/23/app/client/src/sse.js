import { addCardToColumn, moveCardInState, replaceColumnCards, deleteCardFromState } from './store.js';

let eventSource = null;
let statusEl = null;

export function connectSSE() {
  statusEl = document.getElementById('connection-status');

  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource('/api/stream');

  eventSource.onopen = () => {
    setStatus(true);
  };

  eventSource.onerror = () => {
    setStatus(false);
    // EventSource will auto-reconnect
  };

  eventSource.addEventListener('card-created', (e) => {
    try {
      const { card } = JSON.parse(e.data);
      addCardToColumn(card);
    } catch (err) {
      console.error('SSE card-created parse error:', err);
    }
  });

  eventSource.addEventListener('card-moved', (e) => {
    try {
      const { card, fromColumnId } = JSON.parse(e.data);
      moveCardInState(card, fromColumnId);
    } catch (err) {
      console.error('SSE card-moved parse error:', err);
    }
  });

  eventSource.addEventListener('column-renormalized', (e) => {
    try {
      const { columnId, cards } = JSON.parse(e.data);
      replaceColumnCards(columnId, cards);
    } catch (err) {
      console.error('SSE column-renormalized parse error:', err);
    }
  });

  eventSource.addEventListener('card-deleted', (e) => {
    try {
      const { cardId } = JSON.parse(e.data);
      deleteCardFromState(cardId);
    } catch (err) {
      console.error('SSE card-deleted parse error:', err);
    }
  });
}

function setStatus(connected) {
  if (!statusEl) return;
  statusEl.textContent = connected ? 'Connected' : 'Disconnected';
  statusEl.className = 'status ' + (connected ? 'connected' : 'disconnected');
}
