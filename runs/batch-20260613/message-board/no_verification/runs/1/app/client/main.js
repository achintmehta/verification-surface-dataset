/**
 * main.js – Message Board frontend
 *
 * Responsibilities:
 *  1. Fetch message history from GET /api/messages on load.
 *  2. Open an SSE connection to GET /api/stream and append new messages in real-time.
 *  3. Submit new messages via POST /api/messages when the form is submitted.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const API_BASE = '/api';

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const messageList      = /** @type {HTMLUListElement}   */ (document.getElementById('message-list'));
const emptyState       = /** @type {HTMLParagraphElement}*/ (document.getElementById('empty-state'));
const statusIndicator  = /** @type {HTMLSpanElement}    */ (document.getElementById('status-indicator'));
const messageForm      = /** @type {HTMLFormElement}    */ (document.getElementById('message-form'));
const messageInput     = /** @type {HTMLInputElement}   */ (document.getElementById('message-input'));
const formError        = /** @type {HTMLParagraphElement}*/ (document.getElementById('form-error'));
const submitBtn        = /** @type {HTMLButtonElement}  */ (messageForm.querySelector('button[type="submit"]'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a UTC timestamp string into a human-readable local time.
 * @param {string} isoString
 * @returns {string}
 */
function formatTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString(undefined, {
    month:  'short',
    day:    'numeric',
    hour:   '2-digit',
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
  li.classList.add('message-item');
  li.dataset.id = String(message.id);

  const textEl = document.createElement('p');
  textEl.classList.add('message-text');
  textEl.textContent = message.text;

  const metaEl = document.createElement('span');
  metaEl.classList.add('message-meta');
  metaEl.textContent = formatTime(message.created_at);

  li.appendChild(textEl);
  li.appendChild(metaEl);
  return li;
}

/**
 * Append a message to the list and scroll to the bottom.
 * Also hides the empty-state placeholder if it was visible.
 * @param {{ id: number, text: string, created_at: string }} message
 */
function appendMessage(message) {
  emptyState.hidden = true;
  const li = createMessageElement(message);
  messageList.appendChild(li);
  // Scroll the feed to the newest message.
  li.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

/**
 * Update the connection status indicator in the header.
 * @param {'connecting' | 'connected' | 'error'} state
 * @param {string} [label]
 */
function setStatus(state, label) {
  statusIndicator.className = `status status--${state}`;
  const labels = {
    connecting: '● Connecting…',
    connected:  '● Live',
    error:      '● Disconnected',
  };
  statusIndicator.textContent = label ?? labels[state];
  statusIndicator.title = label ?? labels[state];
}

/**
 * Show or hide the inline form error message.
 * @param {string | null} message  – pass null to hide
 */
function setFormError(message) {
  if (message) {
    formError.textContent = message;
    formError.hidden = false;
  } else {
    formError.textContent = '';
    formError.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// 1. Load message history
// ---------------------------------------------------------------------------

/**
 * Fetch all existing messages from the server and render them.
 */
async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    /** @type {Array<{ id: number, text: string, created_at: string }>} */
    const messages = await res.json();

    if (messages.length === 0) {
      emptyState.hidden = false;
    } else {
      emptyState.hidden = true;
      for (const msg of messages) {
        const li = createMessageElement(msg);
        messageList.appendChild(li);
      }
      // Scroll to the bottom after rendering history.
      messageList.lastElementChild?.scrollIntoView({ block: 'end' });
    }
  } catch (err) {
    console.error('[history] failed to load messages:', err);
    emptyState.hidden = false;
    emptyState.textContent = 'Failed to load messages. Please refresh the page.';
  }
}

// ---------------------------------------------------------------------------
// 2. SSE – real-time updates
// ---------------------------------------------------------------------------

/**
 * Open an EventSource connection to /api/stream.
 * Handles reconnection automatically (EventSource does this natively).
 */
function connectSSE() {
  setStatus('connecting');

  const source = new EventSource(`${API_BASE}/stream`);

  // The server sends a "connected" event as soon as the stream is established.
  source.addEventListener('connected', () => {
    setStatus('connected');
    console.log('[sse] connected');
  });

  // The server broadcasts a "new-message" event whenever a message is posted.
  source.addEventListener('new-message', (event) => {
    try {
      const message = JSON.parse(event.data);

      // Avoid duplicates: if we already rendered this message id (e.g. from
      // the optimistic POST response), skip it.
      if (messageList.querySelector(`[data-id="${message.id}"]`)) return;

      appendMessage(message);
    } catch (err) {
      console.error('[sse] failed to parse new-message event:', err);
    }
  });

  source.addEventListener('error', () => {
    setStatus('error');
    console.warn('[sse] connection error – EventSource will retry automatically');
  });

  // When EventSource successfully reconnects after an error, update the status.
  source.addEventListener('open', () => {
    setStatus('connected');
  });
}

// ---------------------------------------------------------------------------
// 3. Form submission – POST /api/messages
// ---------------------------------------------------------------------------

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setFormError(null);

  const text = messageInput.value.trim();
  if (!text) return;

  // Disable the form while the request is in flight.
  submitBtn.disabled = true;
  messageInput.disabled = true;

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
    messageInput.value = '';

    // The SSE broadcast will deliver the new message to all clients including
    // this one. We do NOT manually append here to avoid duplicates – the SSE
    // handler already guards against them via the data-id check.

  } catch (err) {
    console.error('[post] failed to send message:', err);
    setFormError(err.message || 'Failed to send message. Please try again.');
  } finally {
    submitBtn.disabled = false;
    messageInput.disabled = false;
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
