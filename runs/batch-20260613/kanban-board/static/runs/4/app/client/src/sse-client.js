/**
 * SSE client – connects to /api/stream and dispatches events to handlers.
 *
 * Handles:
 *   board:state       – full board snapshot (sent on connect)
 *   card:created      – a new card was created
 *   card:moved        – a card was moved / reordered
 *   column:reordered  – a column's positions were renormalised
 *
 * Reconnects automatically (EventSource does this natively).
 * Updates the connection indicator in the header.
 */

const INDICATOR_EL = () => document.getElementById('connection-indicator');
const LABEL_EL     = () => document.getElementById('connection-label');

function setStatus(status, label) {
  const dot = INDICATOR_EL();
  const lbl = LABEL_EL();
  if (dot) {
    dot.className = `connection-dot ${status}`;
    dot.title = label;
  }
  if (lbl) lbl.textContent = label;
}

/**
 * Connect to the SSE stream and wire up event handlers.
 *
 * @param {{
 *   onBoardState:      (payload: any) => void,
 *   onCardCreated:     (payload: any) => void,
 *   onCardMoved:       (payload: any) => void,
 *   onColumnReordered: (payload: any) => void,
 * }} handlers
 * @returns {EventSource}
 */
export function connectSSE(handlers) {
  setStatus('connecting', 'Connecting…');

  const es = new EventSource('/api/stream');

  es.addEventListener('open', () => {
    setStatus('connected', 'Live');
  });

  es.addEventListener('error', () => {
    setStatus('connecting', 'Reconnecting…');
  });

  es.addEventListener('board:state', (e) => {
    try {
      const payload = JSON.parse(e.data);
      handlers.onBoardState(payload);
    } catch (err) {
      console.error('[sse] Failed to parse board:state', err);
    }
  });

  es.addEventListener('card:created', (e) => {
    try {
      const payload = JSON.parse(e.data);
      handlers.onCardCreated(payload);
    } catch (err) {
      console.error('[sse] Failed to parse card:created', err);
    }
  });

  es.addEventListener('card:moved', (e) => {
    try {
      const payload = JSON.parse(e.data);
      handlers.onCardMoved(payload);
    } catch (err) {
      console.error('[sse] Failed to parse card:moved', err);
    }
  });

  es.addEventListener('column:reordered', (e) => {
    try {
      const payload = JSON.parse(e.data);
      handlers.onColumnReordered(payload);
    } catch (err) {
      console.error('[sse] Failed to parse column:reordered', err);
    }
  });

  return es;
}
