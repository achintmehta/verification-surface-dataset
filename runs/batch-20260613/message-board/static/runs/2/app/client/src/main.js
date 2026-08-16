/**
 * Message Board – Vanilla JS frontend
 *
 * Responsibilities:
 *  1. Fetch message history from GET /api/messages on page load.
 *  2. Connect to the SSE stream at GET /api/stream and append new messages
 *     as they arrive in real time.
 *  3. Submit new messages via POST /api/messages and clear the input.
 */

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const messageList      = /** @type {HTMLUListElement}   */ (document.getElementById('message-list'));
const emptyState       = /** @type {HTMLParagraphElement}*/ (document.getElementById('empty-state'));
const statusIndicator  = /** @type {HTMLSpanElement}    */ (document.getElementById('status-indicator'));
const messageForm      = /** @type {HTMLFormElement}    */ (document.getElementById('message-form'));
const messageInput     = /** @type {HTMLInputElement}   */ (document.getElementById('message-input'));
const sendButton       = /** @type {HTMLButtonElement}  */ (document.getElementById('message-form').querySelector('.send-button'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO timestamp into a human-readable local date/time string.
 *
 * @param {string} isoString
 * @returns {string}
 */
function formatTimestamp(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString(undefined, {
    year:   'numeric',
    month:  'short',
    day:    'numeric',
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Build and return a <li> element representing a single message.
 *
 * @param {{ id: number, text: string, created_at: string }} message
 * @returns {HTMLLIElement}
 */
function createMessageElement(message) {
  const li = document.createElement('li');
  li.classList.add('message-item');
  li.dataset.id = String(message.id);

  const textEl = document.createElement('p');
  textEl.classList.add('message-text');
  textEl.textContent = message.text;

  const metaEl = document.createElement('time');
  metaEl.classList.add('message-meta');
  metaEl.dateTime = message.created_at;
  metaEl.textContent = formatTimestamp(message.created_at);

  li.appendChild(textEl);
  li.appendChild(metaEl);

  return li;
}

/**
 * Append a message to the list and hide the empty-state placeholder.
 * Scrolls the feed to the bottom so the newest message is always visible.
 *
 * @param {{ id: number, text: string, created_at: string }} message
 */
function appendMessage(message) {
  emptyState.classList.add('hidden');
  const li = createMessageElement(message);
  messageList.appendChild(li);
  scrollToBottom();
}

/**
 * Scroll the message feed to the very bottom.
 */
function scrollToBottom() {
  const main = document.querySelector('.app-main');
  if (main) {
    main.scrollTop = main.scrollHeight;
  }
}

// ---------------------------------------------------------------------------
// Status indicator
// ---------------------------------------------------------------------------

/**
 * Update the connection-status pill in the header.
 *
 * @param {'connecting' | 'connected' | 'error'} state
 */
function setStatus(state) {
  statusIndicator.className = `status status--${state}`;
  const labels = {
    connecting: '● Connecting…',
    connected:  '● Live',
    error:      '● Disconnected',
  };
  statusIndicator.textContent = labels[state] ?? labels.connecting;
}

// ---------------------------------------------------------------------------
// 1. Fetch message history
// ---------------------------------------------------------------------------

async function loadHistory() {
  try {
    const response = await fetch('/api/messages');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    /** @type {Array<{ id: number, text: string, created_at: string }>} */
    const messages = await response.json();

    if (messages.length > 0) {
      emptyState.classList.add('hidden');
      for (const msg of messages) {
        const li = createMessageElement(msg);
        messageList.appendChild(li);
      }
      scrollToBottom();
    }
  } catch (err) {
    console.error('[history] failed to load message history:', err);
  }
}

// ---------------------------------------------------------------------------
// 2. SSE – real-time updates
// ---------------------------------------------------------------------------

/**
 * Open an EventSource connection to /api/stream and listen for "message"
 * events.  Reconnects automatically (browser built-in behaviour).
 */
function connectSSE() {
  setStatus('connecting');

  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => {
    setStatus('connected');
    console.log('[sse] connection established');
  });

  /**
   * Handle incoming "message" events broadcast by the server.
   * Each event's data is a JSON-encoded message object.
   */
  source.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      appendMessage(message);
    } catch (err) {
      console.error('[sse] failed to parse message event:', err);
    }
  });

  source.addEventListener('error', () => {
    // The browser will automatically attempt to reconnect; we just update
    // the status indicator to inform the user.
    setStatus('error');
    console.warn('[sse] connection lost – browser will retry automatically');
  });
}

// ---------------------------------------------------------------------------
// 3. Form submission – POST /api/messages
// ---------------------------------------------------------------------------

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = messageInput.value.trim();
  if (!text) return;

  // Disable the form while the request is in flight.
  messageInput.disabled = true;
  sendButton.disabled   = true;

  try {
    const response = await fetch('/api/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }

    // Clear the input on success.  The new message will arrive via SSE so we
    // do NOT manually append it here – that would cause a duplicate.
    messageInput.value = '';
  } catch (err) {
    console.error('[post] failed to send message:', err);
    alert(`Failed to send message: ${err.message}`);
  } finally {
    messageInput.disabled = false;
    sendButton.disabled   = false;
    messageInput.focus();
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

(async () => {
  await loadHistory();
  connectSSE();
})();
