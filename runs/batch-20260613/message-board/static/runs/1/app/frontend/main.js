/**
 * main.js
 * Vanilla JS frontend for the real-time message board.
 *
 * Responsibilities:
 *   1. Fetch historical messages from GET /api/messages on page load
 *   2. Connect to the SSE stream at GET /api/stream
 *   3. Append incoming "new-message" events to the DOM in real time
 *   4. Handle form submission (POST /api/messages) and clear the input
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = '/api';

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const messageList  = /** @type {HTMLOListElement}    */ (document.getElementById('message-list'));
const loadingHint  = /** @type {HTMLParagraphElement} */ (document.getElementById('loading-hint'));
const emptyHint    = /** @type {HTMLParagraphElement} */ (document.getElementById('empty-hint'));
const statusBadge  = /** @type {HTMLSpanElement}      */ (document.getElementById('status-badge'));
const composeForm  = /** @type {HTMLFormElement}       */ (document.getElementById('compose-form'));
const messageInput = /** @type {HTMLInputElement}      */ (document.getElementById('message-input'));
const composeBtn   = /** @type {HTMLButtonElement}     */ (document.getElementById('compose-btn'));
const errorHint    = /** @type {HTMLParagraphElement} */ (document.getElementById('error-hint'));

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
  return date.toLocaleString(undefined, {
    year:   'numeric',
    month:  'short',
    day:    'numeric',
    hour:   '2-digit',
    minute: '2-digit',
  });
}

/**
 * Escape a string so it is safe to insert as text content.
 * (We use textContent for the message body, but this is used for the meta line.)
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build and return a <li> element for a single message.
 * @param {{ id: number, text: string, created_at: string }} message
 * @returns {HTMLLIElement}
 */
function createMessageElement(message) {
  const li = document.createElement('li');
  li.classList.add('message-item');
  li.dataset.id = String(message.id);

  const textEl = document.createElement('p');
  textEl.classList.add('message-text');
  textEl.textContent = message.text;   // textContent prevents XSS

  const metaEl = document.createElement('p');
  metaEl.classList.add('message-meta');
  metaEl.innerHTML = `<time datetime="${escapeHtml(message.created_at)}">${formatTime(message.created_at)}</time>`;

  li.appendChild(textEl);
  li.appendChild(metaEl);
  return li;
}

/**
 * Scroll the feed to the very bottom so the latest message is visible.
 */
function scrollToBottom() {
  const feed = messageList.closest('.feed-wrapper');
  if (feed) {
    feed.scrollTop = feed.scrollHeight;
  }
}

/**
 * Show or hide the "no messages" empty state hint.
 */
function syncEmptyState() {
  if (messageList.children.length === 0) {
    emptyHint.classList.remove('hidden');
  } else {
    emptyHint.classList.add('hidden');
  }
}

/**
 * Append a message to the list and scroll into view.
 * @param {{ id: number, text: string, created_at: string }} message
 */
function appendMessage(message) {
  const li = createMessageElement(message);
  messageList.appendChild(li);
  syncEmptyState();
  scrollToBottom();
}

/**
 * Update the SSE connection status badge.
 * @param {'connecting' | 'connected' | 'disconnected'} state
 */
function setStatus(state) {
  statusBadge.classList.remove('connected', 'disconnected');
  if (state === 'connected') {
    statusBadge.textContent = '● Live';
    statusBadge.classList.add('connected');
  } else if (state === 'disconnected') {
    statusBadge.textContent = '○ Disconnected';
    statusBadge.classList.add('disconnected');
  } else {
    statusBadge.textContent = 'Connecting…';
  }
}

/**
 * Show an error message below the compose form.
 * @param {string} msg
 */
function showError(msg) {
  errorHint.textContent = msg;
  errorHint.classList.remove('hidden');
}

/** Hide the compose-form error hint. */
function clearError() {
  errorHint.textContent = '';
  errorHint.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// 1. Fetch historical messages
// ---------------------------------------------------------------------------

async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    /** @type {Array<{ id: number, text: string, created_at: string }>} */
    const messages = await res.json();

    loadingHint.classList.add('hidden');

    if (messages.length === 0) {
      emptyHint.classList.remove('hidden');
    } else {
      for (const msg of messages) {
        const li = createMessageElement(msg);
        messageList.appendChild(li);
      }
      scrollToBottom();
    }
  } catch (err) {
    console.error('[history] failed to load:', err);
    loadingHint.textContent = 'Failed to load messages. Please refresh.';
  }
}

// ---------------------------------------------------------------------------
// 2 & 3. SSE connection
// ---------------------------------------------------------------------------

/**
 * Open an EventSource connection to /api/stream.
 * Reconnects automatically (EventSource built-in behaviour).
 */
function connectSSE() {
  setStatus('connecting');

  const source = new EventSource(`${API_BASE}/stream`);

  // The server sends a "connected" event once the stream is open.
  source.addEventListener('connected', () => {
    setStatus('connected');
  });

  // The server broadcasts "new-message" events when a message is inserted.
  source.addEventListener('new-message', (event) => {
    try {
      const message = JSON.parse(event.data);

      // Avoid duplicates: the posting client already sees the message via the
      // POST response, but we still append it here because the POST handler
      // does NOT optimistically add it — we rely solely on SSE for consistency.
      // (If the same id is already in the list, skip it.)
      if (messageList.querySelector(`[data-id="${message.id}"]`)) return;

      appendMessage(message);
    } catch (err) {
      console.error('[sse] failed to parse new-message event:', err);
    }
  });

  source.addEventListener('error', () => {
    setStatus('disconnected');
    // EventSource will automatically attempt to reconnect; we just update the UI.
  });

  // When EventSource successfully reconnects after an error, the 'open' event fires.
  source.addEventListener('open', () => {
    // Only update to "connected" once we've received the server's "connected" event,
    // but set to "connecting" here to give immediate feedback.
    setStatus('connecting');
  });
}

// ---------------------------------------------------------------------------
// 4 & 5. Form submission
// ---------------------------------------------------------------------------

composeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

  const text = messageInput.value.trim();
  if (!text) return;

  // Disable the form while the request is in-flight.
  messageInput.disabled = true;
  composeBtn.disabled   = true;

  try {
    const res = await fetch(`${API_BASE}/messages`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }

    // Clear the input on success.
    // The new message will arrive via SSE and be appended to the list.
    messageInput.value = '';
  } catch (err) {
    console.error('[post] failed to send message:', err);
    showError(err instanceof Error ? err.message : 'Failed to send message. Please try again.');
  } finally {
    messageInput.disabled = false;
    composeBtn.disabled   = false;
    messageInput.focus();
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

loadHistory();
connectSSE();
