/**
 * main.js – Message Board frontend
 *
 * Responsibilities:
 *  1. Fetch message history from GET /api/messages on load.
 *  2. Connect to the SSE stream at GET /api/stream and append new messages.
 *  3. Submit new messages via POST /api/messages and clear the input.
 */

// ── Constants ──────────────────────────────────────────────────────────────
const API_BASE   = '/api';
const MESSAGES_URL = `${API_BASE}/messages`;
const STREAM_URL   = `${API_BASE}/stream`;

// ── DOM references ─────────────────────────────────────────────────────────
const messageList    = /** @type {HTMLUListElement}   */ (document.getElementById('message-list'));
const emptyState     = /** @type {HTMLParagraphElement}*/ (document.getElementById('empty-state'));
const statusIndicator= /** @type {HTMLSpanElement}    */ (document.getElementById('status-indicator'));
const composeForm    = /** @type {HTMLFormElement}    */ (document.getElementById('compose-form'));
const messageInput   = /** @type {HTMLInputElement}   */ (document.getElementById('message-input'));
const composeBtn     = /** @type {HTMLButtonElement}  */ (document.querySelector('.compose-btn'));
const composeError   = /** @type {HTMLParagraphElement}*/ (document.getElementById('compose-error'));

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Format an ISO timestamp into a human-readable local time string.
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
 * Escape a string so it is safe to insert as text content.
 * (We use textContent rather than innerHTML, so this is belt-and-suspenders.)
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build and return a <li> element for a single message object.
 * @param {{ id: number, text: string, created_at: string }} message
 * @returns {HTMLLIElement}
 */
function createMessageElement(message) {
  const li   = document.createElement('li');
  li.classList.add('message-item');
  li.dataset.id = String(message.id);

  const textEl = document.createElement('p');
  textEl.classList.add('message-text');
  textEl.textContent = message.text;   // textContent is XSS-safe

  const metaEl = document.createElement('p');
  metaEl.classList.add('message-meta');
  metaEl.textContent = formatTime(message.created_at);

  li.appendChild(textEl);
  li.appendChild(metaEl);
  return li;
}

/**
 * Append a message element to the list and scroll to the bottom.
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
 * Show or hide the empty-state placeholder based on whether the list is empty.
 */
function syncEmptyState() {
  emptyState.hidden = messageList.childElementCount > 0;
}

// ── SSE status helpers ─────────────────────────────────────────────────────

function setStatus(state) {
  statusIndicator.className = `status status--${state}`;
  const labels = {
    connecting: '● Connecting…',
    connected:  '● Live',
    error:      '● Disconnected',
  };
  statusIndicator.textContent = labels[state] ?? state;
}

// ── 1. Load message history ────────────────────────────────────────────────

async function loadHistory() {
  try {
    const res = await fetch(MESSAGES_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();

    for (const msg of messages) {
      appendMessage(msg);
    }
    syncEmptyState();
  } catch (err) {
    console.error('[history] Failed to load messages:', err);
    // Non-fatal – the user can still post and receive live updates.
    syncEmptyState();
  }
}

// ── 2. SSE connection ──────────────────────────────────────────────────────

/**
 * Set of message IDs we have already rendered.
 * Prevents duplicates when the SSE stream delivers a message that was also
 * returned by the initial history fetch (race condition on slow networks).
 * @type {Set<number>}
 */
const renderedIds = new Set();

function connectSSE() {
  setStatus('connecting');
  const source = new EventSource(STREAM_URL);

  source.addEventListener('open', () => {
    setStatus('connected');
  });

  /**
   * Handle `new-message` events pushed by the server.
   * The server sends: event: new-message\ndata: <JSON>\n\n
   */
  source.addEventListener('new-message', (event) => {
    try {
      const message = JSON.parse(event.data);

      // Deduplicate: skip if we already rendered this message from history.
      if (renderedIds.has(message.id)) return;
      renderedIds.add(message.id);

      appendMessage(message);
    } catch (err) {
      console.error('[sse] Failed to parse new-message event:', err);
    }
  });

  source.addEventListener('error', () => {
    setStatus('error');
    // EventSource will automatically attempt to reconnect; we just update UI.
  });
}

// ── 3. Form submission ─────────────────────────────────────────────────────

function showComposeError(msg) {
  composeError.textContent = msg;
  composeError.hidden = false;
}

function clearComposeError() {
  composeError.textContent = '';
  composeError.hidden = true;
}

composeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearComposeError();

  const text = messageInput.value.trim();
  if (!text) return;

  // Disable the form while the request is in-flight.
  messageInput.disabled = true;
  composeBtn.disabled   = true;

  try {
    const res = await fetch(MESSAGES_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }

    // The server will broadcast the new message via SSE; we don't need to
    // manually append it here – the SSE handler will do that.
    // We do, however, track the returned ID so the SSE dedup logic works.
    const saved = await res.json();
    renderedIds.add(saved.id);
    appendMessage(saved);

    // Clear the input on success.
    messageInput.value = '';
  } catch (err) {
    console.error('[compose] Failed to post message:', err);
    showComposeError(err.message || 'Failed to send message. Please try again.');
  } finally {
    messageInput.disabled = false;
    composeBtn.disabled   = false;
    messageInput.focus();
  }
});

// ── Bootstrap ──────────────────────────────────────────────────────────────

(async () => {
  await loadHistory();

  // Track IDs from history to avoid duplicates from SSE.
  for (const li of messageList.querySelectorAll('.message-item')) {
    renderedIds.add(Number(li.dataset.id));
  }

  connectSSE();
})();
