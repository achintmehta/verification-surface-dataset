/**
 * SSE client module.
 *
 * Connects to GET /api/stream and dispatches incoming events to registered
 * handlers. Handles reconnection automatically via EventSource's built-in
 * retry mechanism and updates the status indicator in the header.
 *
 * Usage:
 *   import { initSSE, onSSE } from './sse.js';
 *   onSSE('card-created', handler);   // register before or after initSSE
 *   initSSE(statusEl);
 */

const SSE_URL = '/api/stream';

/** @type {EventSource|null} */
let es = null;

/** @type {HTMLElement|null} */
let statusEl = null;

/**
 * Registry: event name → array of application handlers.
 * We attach exactly ONE EventSource listener per event name; that listener
 * fans out to all registered application handlers.
 * @type {Map<string, Function[]>}
 */
const registry = new Map();

/**
 * Track which event names already have an EventSource listener attached,
 * so we never attach more than one per event.
 * @type {Set<string>}
 */
const attached = new Set();

/**
 * Register a handler for a named SSE event.
 * Safe to call before or after initSSE().
 *
 * @param {string}   event
 * @param {Function} handler  - called with the parsed JSON payload
 */
export function onSSE(event, handler) {
  if (!registry.has(event)) registry.set(event, []);
  registry.get(event).push(handler);

  // If the EventSource is already open and we haven't attached a listener
  // for this event yet, do so now.
  if (es && !attached.has(event)) {
    attachListener(event);
  }
}

/**
 * Initialise the SSE connection.
 *
 * @param {HTMLElement} indicator - DOM element showing connection state
 */
export function initSSE(indicator) {
  statusEl = indicator;
  setStatus('connecting');

  es = new EventSource(SSE_URL);

  es.addEventListener('open', () => {
    setStatus('connected');
    console.log('[sse] Connected to /api/stream');
  });

  es.addEventListener('error', () => {
    setStatus('disconnected');
    console.warn('[sse] Connection error – EventSource will retry automatically.');
  });

  // Attach listeners for all events registered before initSSE() was called
  for (const event of registry.keys()) {
    attachListener(event);
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * Attach a single EventSource listener for `event` that fans out to all
 * registered application handlers. Idempotent – safe to call multiple times.
 */
function attachListener(event) {
  if (!es || attached.has(event)) return;
  attached.add(event);

  es.addEventListener(event, (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    for (const h of registry.get(event) ?? []) {
      try { h(data); } catch (err) {
        console.error(`[sse] Handler error for "${event}":`, err);
      }
    }
  });
}

function setStatus(state) {
  if (!statusEl) return;
  statusEl.className = `sse-status ${state}`;
  const labels = {
    connected:    'Real-time: Connected',
    connecting:   'Real-time: Connecting…',
    disconnected: 'Real-time: Disconnected (retrying)',
  };
  statusEl.title = labels[state] ?? state;
}
