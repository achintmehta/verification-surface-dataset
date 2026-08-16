/**
 * Message Board – frontend entry point
 *
 * Responsibilities:
 *  1. Fetch message history from GET /api/messages on page load.
 *  2. Connect to the SSE stream at GET /api/stream and append new messages
 *     in real-time.
 *  3. Handle form submission: POST /api/messages, then clear the input.
 */

// ── Configuration ──────────────────────────────────────────────────────────
// During development the Vite dev server proxies /api/* to the Express
// backend (see vite.config.js), so we can use a relative base URL.
const API_BASE = '/api';

// ── DOM references ─────────────────────────────────────────────────────────
const messageList      = /** @type {HTMLUListElement}   */ (document.getElementById('message-list'));
const loadingIndicator = /** @type {HTMLParagraphElement} */ (document.getElementById('loading-indicator'));
const emptyIndicator   = /** @type {HTMLParagraphElement} */ (document.getElementById('empty-indicator'));
const messageForm      = /** @type {HTMLFormElement}    */ (document.getElementById('message-form'));
const messageInput     = /** @type {HTMLInputElement}   */ (document.getElementById('message-input'));
const sendBtn          = /** @type {HTMLButtonElement}  */ (document.querySelector('.compose-btn'));
const statusIndicator  = /** @type {HTMLSpanElement}    */ (document.getElementById('status-indicator'));
const statusLabel      = /** @type {HTMLSpanElement}    */ (statusIndicator.querySelector('.status__label'));
const errorBanner      = /** @type {HTMLParagraphElement} */ (document.getElementById('error-banner'));

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Format an ISO timestamp into a human-readable local time string.
 * @param {string} isoString
 * @returns {string}
 */
function formatTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString(undefined, {
    year:   'numeric',
    month:  'short',
    day:    'numeric',
    hour:   '2-digit',
    minute: '2-digit',
  });
}

/**
 * Create and return a <li> element representing a single message.
 * @param {{ id: number, text: string, created_at: string }} message
 * @returns {HTMLLIElement}
 */
function createMessageElement(message) {
  const li = document.createElement('li');
  li.classList.add('message-item');
  li.dataset.id = String(message.id);

  const textEl = document.createElement('p');
  textEl.classList.add('message-item__text');
  textEl.textContent = message.text;

  const metaEl = document.createElement('span');
  metaEl.classList.add('message-item__meta');
  metaEl.textContent = formatTime(message.created_at);

  li.appendChild(textEl);
  li.appendChild(metaEl);
  return li;
}

/**
 * Append a message element to the list and scroll the feed to the bottom.
 * Also hides the "empty" placeholder if it was visible.
 * @param {{ id: number, text: string, created_at: string }} message
 */
function appendMessage(message) {
  emptyIndicator.hidden = true;
  const li = createMessageElement(message);
  messageList.appendChild(li);
  scrollToBottom();
}

/** Scroll the feed container to the very bottom. */
function scrollToBottom() {
  const feed = messageList.closest('.feed-container');
  if (feed) {
    feed.scrollTop = feed.scrollHeight;
  }
}

/**
 * Update the SSE status indicator chip.
 * @param {'connecting'|'live'|'error'} state
 * @param {string} [label]
 */
function setStatus(state, label) {
  statusIndicator.className = `status status--${state}`;
  statusLabel.textContent = label ?? { connecting: 'Connecting…', live: 'Live', error: 'Disconnected' }[state];
}

/**
 * Show or hide the error banner below the compose form.
 * @param {string|null} message  Pass null to hide.
 */
function showError(message) {
  if (message) {
    errorBanner.textContent = message;
    errorBanner.hidden = false;
  } else {
    errorBanner.hidden = true;
    errorBanner.textContent = '';
  }
}

// ── 1. Load message history ────────────────────────────────────────────────

async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/messages`);
    if (!res.ok) throw new Error(`Server responded with ${res.status}`);

    /** @type {Array<{ id: number, text: string, created_at: string }>} */
    const messages = await res.json();

    // Hide the loading spinner regardless of whether there are messages.
    loadingIndicator.hidden = true;

    if (messages.length === 0) {
      emptyIndicator.hidden = false;
      return;
    }

    for (const msg of messages) {
      const li = createMessageElement(msg);
      messageList.appendChild(li);
    }

    // Scroll to the bottom after the initial render so the newest message
    // is visible without the user having to scroll manually.
    scrollToBottom();
  } catch (err) {
    loadingIndicator.hidden = true;
    console.error('[history] failed to load messages:', err);
    showError('Could not load message history. Please refresh the page.');
  }
}

// ── 2. SSE real-time connection ────────────────────────────────────────────

/**
 * Open an EventSource connection to the SSE endpoint and wire up event
 * handlers.  Reconnection is handled automatically by the browser's
 * EventSource implementation.
 */
function connectSSE() {
  setStatus('connecting');

  const source = new EventSource(`${API_BASE}/stream`);

  // The server sends a "connected" event immediately after the stream opens.
  source.addEventListener('connected', () => {
    setStatus('live', 'Live');
    console.log('[sse] stream connected');
  });

  // The server broadcasts a "new-message" event whenever a message is posted.
  source.addEventListener('new-message', (event) => {
    try {
      const message = JSON.parse(event.data);
      appendMessage(message);
    } catch (err) {
      console.error('[sse] failed to parse new-message event:', err);
    }
  });

  source.addEventListener('error', () => {
    // EventSource will automatically attempt to reconnect; we just update
    // the UI to reflect the temporary disconnection.
    setStatus('error', 'Reconnecting…');
    console.warn('[sse] connection lost – browser will retry automatically');
  });

  // If the connection is re-established after an error, update the status.
  source.addEventListener('open', () => {
    setStatus('live', 'Live');
  });

  return source;
}

// ── 3. Form submission ─────────────────────────────────────────────────────

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError(null);

  const text = messageInput.value.trim();
  if (!text) return;

  // Disable the form while the request is in-flight to prevent double-sends.
  messageInput.disabled = true;
  sendBtn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/messages`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Server error ${res.status}`);
    }

    // Clear the input on success.  The new message will arrive via SSE so
    // we do NOT manually append it here – that would cause a duplicate.
    messageInput.value = '';
  } catch (err) {
    console.error('[post] failed to send message:', err);
    showError(err.message || 'Failed to send message. Please try again.');
  } finally {
    messageInput.disabled = false;
    sendBtn.disabled = false;
    messageInput.focus();
  }
});

// ── Bootstrap ──────────────────────────────────────────────────────────────

loadHistory();
connectSSE();
