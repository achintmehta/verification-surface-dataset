/**
 * SSE client.
 * Connects to /api/stream and dispatches events to registered handlers.
 */

const SSE_URL = 'http://localhost:3001/api/stream';

let es = null;
const handlers = {};

/**
 * Start the SSE connection.
 * @param {object} eventHandlers  - { 'event-name': handlerFn, ... }
 * @param {Function} onStatusChange - called with 'connected' | 'disconnected'
 */
export function connectSSE(eventHandlers, onStatusChange) {
  Object.assign(handlers, eventHandlers);

  function connect() {
    es = new EventSource(SSE_URL);

    es.onopen = () => {
      onStatusChange?.('connected');
    };

    es.onerror = () => {
      onStatusChange?.('disconnected');
      es.close();
      // Reconnect after 3 s
      setTimeout(connect, 3000);
    };

    // Register named-event listeners
    for (const [event, handler] of Object.entries(handlers)) {
      es.addEventListener(event, (e) => {
        try {
          const data = JSON.parse(e.data);
          handler(data);
        } catch (err) {
          console.error(`SSE parse error for event "${event}":`, err);
        }
      });
    }
  }

  connect();
}

export function disconnectSSE() {
  es?.close();
  es = null;
}
