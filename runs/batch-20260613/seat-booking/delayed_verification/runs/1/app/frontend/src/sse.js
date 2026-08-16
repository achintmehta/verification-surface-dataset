/**
 * sse.js – EventSource client that keeps the seat map live.
 *
 * Listens for:
 *   seats_held     – { holdId, sessionId, seatIds, expiresAt }
 *   seats_booked   – { holdId, sessionId, seatIds }
 *   seats_released – { seatIds, holdId? }
 */

import { applySeatUpdates, getState, setState } from './store.js';
import { patchSeatElements }                    from './seatMap.js';
import { updateInventory, stopCountdown }       from './ui.js';

let es = null;
let reconnectTimer = null;
const RECONNECT_DELAY_MS = 3000;

export function connectSSE() {
  if (es) return; // already connected

  function connect() {
    es = new EventSource('/api/stream');

    es.addEventListener('connected', () => {
      console.log('[SSE] connected');
    });

    es.addEventListener('seats_held', (e) => {
      const { seatIds, expiresAt, holdId } = JSON.parse(e.data);
      const { activeHold } = getState();

      // Don't overwrite our own hold's seats (already reflected in state).
      if (activeHold && activeHold.id === holdId) return;

      applySeatUpdates(seatIds, 'held', { expiresAt });
      patchSeatElements(seatIds);
      updateInventory();
    });

    es.addEventListener('seats_booked', (e) => {
      const { seatIds, holdId } = JSON.parse(e.data);
      const { booking } = getState();

      // Don't overwrite our own booking (already reflected).
      if (booking && booking.holdId === holdId) return;

      applySeatUpdates(seatIds, 'booked', { holdId });
      patchSeatElements(seatIds);
      updateInventory();
    });

    es.addEventListener('seats_released', (e) => {
      const { seatIds, holdId } = JSON.parse(e.data);
      const { activeHold } = getState();

      // If the server released OUR hold (e.g., it expired server-side and
      // the periodic sweep caught it before our client-side watcher did),
      // clear the active hold state.
      if (holdId && activeHold && activeHold.id === holdId) {
        setState({ activeHold: null, selectedIds: new Set() });
        stopCountdown();
        // The expiry watcher in main.js will also fire, but that's harmless.
      }

      applySeatUpdates(seatIds, 'available', {});
      patchSeatElements(seatIds);
      updateInventory();
    });

    es.onerror = () => {
      console.warn('[SSE] connection error – reconnecting in', RECONNECT_DELAY_MS, 'ms');
      es.close();
      es = null;
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    };
  }

  connect();
}

export function disconnectSSE() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (es) { es.close(); es = null; }
}
