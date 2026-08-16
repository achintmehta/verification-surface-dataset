/**
 * main.js
 * Entry point for the Message Board frontend.
 *
 * Responsibilities:
 *   1. Fetch message history from GET /api/messages on page load.
 *   2. Open an SSE connection to GET /api/stream and append incoming messages.
 *   3. Handle form submission: POST /api/messages, then clear the input.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Base URL of the backend API. Adjust if the server runs on a different port. */
const API_BASE = 'http://localhost:3001';

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const messageList     = /** @type {HTMLUListElement}   */ (document.getElementById('message-list'));
const emptyState      = /** @type {HTMLLIElement}      */ (document.getElementById('empty-state'));
const composeForm     = /** @type {HTMLFormElement}    */ (document.getElementById('compose-form'));
const messageInput    = /** @type {HTMLInputElement}   */ (document.getElementById('message-input'));
const statusIndicator = /** @type {HTMLSpanElement}    */ (document.getElementById('status-indicator'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO timestamp into a human-readable local time string.
 * @param {string} isoString
 * @returns {string}
 */
function formatTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Build and return a <li> element representing a single message.
 * @param {{ id: number, text: string, created_at: string }} message
 * @returns {HTMLLIElement}
 */
function createMessageElement(message) {
  const li = document.createElement('li');
  li.classList.add('message');
  li.dataset.id = String(message.id);

  const textEl = document.createElement('p');
  textEl.classList.add('message__text');
  textEl.textContent = message.text;

  const timeEl = document.createElement('time');
  timeEl.classList.add('message__time');
  timeEl.dateTime = message.created_at;
  timeEl.textContent = formatTime(message.created_at);

  li.appendChild(textEl);
  li.appendChild(timeEl);
  return li;
}

/**
 * Append a message element to the list, hiding the empty-state placeholder,
 * and scroll the feed to the bottom.
 * @param {{ id: number, text: string, created_at: string }} message
 */
function appendMessage(message) {
  // Hide the "no messages" placeholder once we have at least one message.
  if (emptyState) {
    emptyState.style.display = 'none';
  }

  const li = createMessageElement(message);
  messageList.appendChild(li);

  // Scroll to the newest message.
  li.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

/**
 * Update the connection status badge in the header.
 * @param {'connecting' | 'connected' | 'error'} state
 * @param {string} label
 */
function setStatus(state, label) {
  statusIndicator.className = `status status--${state}`;
  statusIndicator.textContent = label;
}

// ---------------------------------------------------------------------------
// 1. Load message history
// ---------------------------------------------------------------------------

async function loadHistory() {
  try {
    const response = await fetch(`${API_BASE}/api/messages`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    /** @type {Array<{ id: number, text: string, created_at: string }>} */
    const messages = await response.json();

    if (messages.length > 0) {
      // Render all historical messages without animation delay.
      messages.forEach(appendMessage);
    }
  } catch (err) {
    console.error('[history] failed to load:', err);
    // Non-fatal – the user can still post and receive live updates.
  }
}

// ---------------------------------------------------------------------------
// 2. SSE connection
// ---------------------------------------------------------------------------

/**
 * Open an EventSource connection to the SSE endpoint.
 * Reconnection is handled automatically by the browser's EventSource API.
 */
function connectSSE() {
  setStatus('connecting', '● Connecting…');

  const source = new EventSource(`${API_BASE}/api/stream`);

  // The server sends a "connected" event immediately after the handshake.
  source.addEventListener('connected', () => {
    setStatus('connected', '● Live');
    console.log('[sse] connection established');
  });

  // Each new message posted by any client is broadcast as a "message" event.
  source.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      appendMessage(message);
    } catch (err) {
      console.error('[sse] failed to parse message event:', err);
    }
  });

  source.addEventListener('error', () => {
    setStatus('error', '● Reconnecting…');
    console.warn('[sse] connection error – browser will retry automatically');
  });
}

// ---------------------------------------------------------------------------
// 3. Form submission
// ---------------------------------------------------------------------------

composeForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = messageInput.value.trim();
  if (!text) return;

  // Disable the form while the request is in-flight to prevent double-sends.
  messageInput.disabled = true;
  const submitBtn = /** @type {HTMLButtonElement} */ (composeForm.querySelector('button[type="submit"]'));
  submitBtn.disabled = true;

  try {
    const response = await fetch(`${API_BASE}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }

    // Clear the input on success.
    // NOTE: We do NOT manually append the message here – the SSE broadcast
    // will deliver it back to this client just like any other client,
    // ensuring a single, consistent code path for rendering new messages.
    messageInput.value = '';
  } catch (err) {
    console.error('[post] failed to send message:', err);
    alert(`Could not send message: ${err.message}`);
  } finally {
    messageInput.disabled = false;
    submitBtn.disabled = false;
    messageInput.focus();
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

// Load history first, then open the SSE stream so we don't miss any messages
// that arrive between the history fetch and the stream connection.
// (In practice the gap is negligible, but ordering matters for correctness.)
(async () => {
  await loadHistory();
  connectSSE();
})();
