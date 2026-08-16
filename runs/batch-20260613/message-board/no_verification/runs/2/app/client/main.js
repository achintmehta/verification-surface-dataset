/**
 * main.js – Message Board frontend
 *
 * Responsibilities:
 *  1. Fetch message history from GET /api/messages on load.
 *  2. Open an SSE connection to GET /api/stream and append new messages live.
 *  3. Submit new messages via POST /api/messages on form submit.
 */

// ── Constants ──────────────────────────────────────────────────────────────
const API_BASE = '/api';

// ── DOM references ─────────────────────────────────────────────────────────
const messageList  = /** @type {HTMLOListElement}   */ (document.getElementById('message-list'));
const emptyState   = /** @type {HTMLParagraphElement}*/ (document.getElementById('empty-state'));
const statusBadge  = /** @type {HTMLSpanElement}    */ (document.getElementById('status-badge'));
const composeForm  = /** @type {HTMLFormElement}    */ (document.getElementById('compose-form'));
const messageInput = /** @type {HTMLInputElement}   */ (document.getElementById('message-input'));
const composeBtn   = /** @type {HTMLButtonElement}  */ (document.getElementById('compose-btn'));
const composeError = /** @type {HTMLParagraphElement}*/ (document.getElementById('compose-error'));

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Format an ISO timestamp into a human-readable local date/time string.
 * @param {string} isoString
 * @returns {string}
 */
function formatDate(isoString) {
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
 * Build and return a <li> element for a single message object.
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
  metaEl.textContent = formatDate(message.created_at);

  li.appendChild(textEl);
  li.appendChild(metaEl);
  return li;
}

/**
 * Append a message element to the list and hide the empty-state notice.
 * Scrolls the new message into view.
 * @param {{ id: number, text: string, created_at: string }} message
 */
function appendMessage(message) {
  // Guard: don't add duplicates (can happen if POST response races SSE event)
  if (messageList.querySelector(`[data-id="${message.id}"]`)) return;

  emptyState.hidden = true;
  const li = createMessageElement(message);
  messageList.appendChild(li);
  li.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

// ── Status badge helpers ───────────────────────────────────────────────────

function setStatus(state) {
  statusBadge.className = 'status-badge ' + state;
  const labels = {
    connected:    '● Connected',
    disconnected: '● Disconnected',
    connecting:   'Connecting…',
  };
  statusBadge.textContent = labels[state] ?? state;
}

// ── 1. Load message history ────────────────────────────────────────────────

async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();

    if (messages.length === 0) {
      emptyState.hidden = false;
    } else {
      emptyState.hidden = true;
      for (const msg of messages) {
        const li = createMessageElement(msg);
        messageList.appendChild(li);
      }
      // Scroll to the bottom so the latest message is visible
      messageList.lastElementChild?.scrollIntoView({ block: 'end' });
    }
  } catch (err) {
    console.error('[history] failed to load messages:', err);
    emptyState.hidden = false;
    emptyState.textContent = 'Could not load messages. Is the server running?';
  }
}

// ── 2. SSE connection ──────────────────────────────────────────────────────

function connectSSE() {
  setStatus('connecting');

  const source = new EventSource(`${API_BASE}/stream`);

  source.addEventListener('connected', () => {
    setStatus('connected');
  });

  source.addEventListener('new-message', (event) => {
    try {
      const message = JSON.parse(event.data);
      appendMessage(message);
    } catch (err) {
      console.error('[sse] failed to parse new-message event:', err);
    }
  });

  source.addEventListener('error', () => {
    setStatus('disconnected');
    // EventSource will automatically attempt to reconnect; we just update the UI.
  });

  // When the browser successfully re-establishes the connection after an error
  source.addEventListener('open', () => {
    setStatus('connected');
  });

  return source;
}

// ── 3. Form submission ─────────────────────────────────────────────────────

function showError(message) {
  composeError.textContent = message;
  composeError.hidden = false;
}

function clearError() {
  composeError.textContent = '';
  composeError.hidden = true;
}

composeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

  const text = messageInput.value.trim();
  if (!text) return;

  // Disable the form while the request is in flight
  messageInput.disabled = true;
  composeBtn.disabled   = true;
  composeBtn.textContent = 'Sending…';

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
    // The SSE broadcast will add the message to the list; we don't add it here
    // to avoid duplicates. However, appendMessage() guards against duplicates
    // via data-id, so it is safe even if the POST response arrives before SSE.
    messageInput.value = '';
  } catch (err) {
    console.error('[post] failed to send message:', err);
    showError(err.message || 'Failed to send message. Please try again.');
  } finally {
    messageInput.disabled  = false;
    composeBtn.disabled    = false;
    composeBtn.textContent = 'Send';
    messageInput.focus();
  }
});

// ── Bootstrap ──────────────────────────────────────────────────────────────

loadHistory();
connectSSE();
