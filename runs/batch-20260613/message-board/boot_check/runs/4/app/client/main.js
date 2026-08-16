/**
 * Message Board – frontend entry point
 *
 * Responsibilities:
 *  1. Fetch message history on load and render it.
 *  2. Open an SSE connection and append incoming messages in real-time.
 *  3. Handle form submission (POST /api/messages) and clear the input.
 */

// ── DOM references ────────────────────────────────────────────────────────────
const messageList      = /** @type {HTMLUListElement}   */ (document.getElementById('message-list'));
const emptyState       = /** @type {HTMLParagraphElement}*/ (document.getElementById('empty-state'));
const statusIndicator  = /** @type {HTMLSpanElement}    */ (document.getElementById('status-indicator'));
const composeForm      = /** @type {HTMLFormElement}    */ (document.getElementById('compose-form'));
const messageInput     = /** @type {HTMLInputElement}   */ (document.getElementById('message-input'));
const composeBtn       = /** @type {HTMLButtonElement}  */ (composeForm.querySelector('.compose-btn'));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Format an ISO timestamp into a human-readable local time string.
 * @param {string} iso
 * @returns {string}
 */
function formatTime(iso) {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month:  'short',
    day:    'numeric',
    hour:   '2-digit',
    minute: '2-digit',
  });
}

/**
 * Build and return a <li> element for a single message.
 * @param {{ id: number, text: string, created_at: string }} message
 * @returns {HTMLLIElement}
 */
function createMessageElement(message) {
  const li   = document.createElement('li');
  li.className   = 'message-item';
  li.dataset.id  = String(message.id);

  const textEl = document.createElement('p');
  textEl.className = 'message-text';
  textEl.textContent = message.text;

  const metaEl = document.createElement('time');
  metaEl.className   = 'message-meta';
  metaEl.dateTime    = message.created_at;
  metaEl.textContent = formatTime(message.created_at);

  li.appendChild(textEl);
  li.appendChild(metaEl);
  return li;
}

/**
 * Append a message to the list and hide the empty-state notice.
 * Scrolls the board to the bottom so the newest message is visible.
 * @param {{ id: number, text: string, created_at: string }} message
 */
function appendMessage(message) {
  emptyState.hidden = true;
  messageList.appendChild(createMessageElement(message));
  // Scroll the scrollable parent (.board) to the bottom.
  messageList.parentElement?.scrollTo({ top: messageList.parentElement.scrollHeight, behavior: 'smooth' });
}

/**
 * Update the connection-status badge.
 * @param {'connecting'|'connected'|'error'} state
 * @param {string} label
 */
function setStatus(state, label) {
  statusIndicator.className = `status status--${state}`;
  statusIndicator.textContent = label;
}

// ── 1. Load message history ───────────────────────────────────────────────────

async function loadHistory() {
  try {
    const res = await fetch('/api/messages');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    /** @type {Array<{ id: number, text: string, created_at: string }>} */
    const messages = await res.json();

    if (messages.length === 0) {
      emptyState.hidden = false;
    } else {
      messages.forEach(appendMessage);
    }
  } catch (err) {
    console.error('[history] failed to load messages:', err);
    emptyState.hidden = false;
    emptyState.textContent = '⚠️ Could not load messages. Is the server running?';
  }
}

// ── 2. SSE – real-time updates ────────────────────────────────────────────────

// Track IDs we have already rendered so we never show a duplicate
// (the POST response and the SSE broadcast could theoretically both arrive).
const renderedIds = new Set();

/**
 * Safely append a message only if it hasn't been rendered yet.
 * @param {{ id: number, text: string, created_at: string }} message
 */
function safeAppend(message) {
  if (renderedIds.has(message.id)) return;
  renderedIds.add(message.id);
  appendMessage(message);
}

function connectSSE() {
  setStatus('connecting', '● Connecting…');

  const source = new EventSource('/api/stream');

  source.addEventListener('connected', () => {
    setStatus('connected', '● Live');
  });

  source.addEventListener('new-message', (event) => {
    try {
      const message = JSON.parse(event.data);
      safeAppend(message);
    } catch (err) {
      console.error('[sse] failed to parse new-message event:', err);
    }
  });

  source.addEventListener('error', () => {
    setStatus('error', '● Reconnecting…');
    // EventSource reconnects automatically; we just update the badge.
  });

  return source;
}

// ── 3. Form submission ────────────────────────────────────────────────────────

composeForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = messageInput.value.trim();
  if (!text) return;

  // Disable the form while the request is in-flight.
  composeBtn.disabled  = true;
  messageInput.disabled = true;

  try {
    const res = await fetch('/api/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }

    /** @type {{ id: number, text: string, created_at: string }} */
    const message = await res.json();

    // Optimistically render the message from the POST response.
    // The SSE broadcast will be ignored for this id via safeAppend().
    safeAppend(message);

    // Clear the input on success.
    messageInput.value = '';
  } catch (err) {
    console.error('[post] failed to send message:', err);
    alert(`Failed to send message: ${err.message}`);
  } finally {
    composeBtn.disabled   = false;
    messageInput.disabled = false;
    messageInput.focus();
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

(async () => {
  await loadHistory();

  // Populate the renderedIds set from whatever was already rendered.
  for (const li of messageList.querySelectorAll('.message-item[data-id]')) {
    renderedIds.add(Number(li.dataset.id));
  }

  connectSSE();
})();
