/**
 * main.js – Message Board frontend
 *
 * Responsibilities:
 *  1. Fetch message history from GET /api/messages on load.
 *  2. Open an SSE connection to GET /api/stream and append new messages live.
 *  3. Submit new messages via POST /api/messages on form submit.
 */

// ── Constants ──────────────────────────────────────────────────────────────
const API_BASE    = '/api';
const MESSAGES_EP = `${API_BASE}/messages`;
const STREAM_EP   = `${API_BASE}/stream`;

// ── DOM references ─────────────────────────────────────────────────────────
const messageList   = /** @type {HTMLUListElement}   */ (document.getElementById('message-list'));
const emptyState    = /** @type {HTMLParagraphElement}*/ (document.getElementById('empty-state'));
const statusEl      = /** @type {HTMLSpanElement}    */ (document.getElementById('status-indicator'));
const statusLabel   = /** @type {HTMLSpanElement}    */ (statusEl.querySelector('.status__label'));
const composeForm   = /** @type {HTMLFormElement}    */ (document.getElementById('compose-form'));
const messageInput  = /** @type {HTMLInputElement}   */ (document.getElementById('message-input'));
const sendBtn       = /** @type {HTMLButtonElement}  */ (composeForm.querySelector('button[type="submit"]'));

// ── Tracks IDs we have already rendered (prevents duplicates) ──────────────
const renderedIds = new Set();

// ── Helpers ────────────────────────────────────────────────────────────────

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
 * Build and return a <li> element for a single message.
 * @param {{ id: number, text: string, created_at: string }} msg
 * @returns {HTMLLIElement}
 */
function createMessageElement(msg) {
  const li = document.createElement('li');
  li.className = 'message-item';
  li.dataset.id = String(msg.id);

  const bubble = document.createElement('div');
  bubble.className = 'message-item__bubble';
  bubble.textContent = msg.text;

  const meta = document.createElement('span');
  meta.className = 'message-item__meta';
  meta.textContent = formatTime(msg.created_at);

  li.appendChild(bubble);
  li.appendChild(meta);
  return li;
}

/**
 * Append a message to the list, avoiding duplicates.
 * Scrolls the feed to the bottom after insertion.
 * @param {{ id: number, text: string, created_at: string }} msg
 * @param {boolean} [animate=true]
 */
function appendMessage(msg, animate = true) {
  if (renderedIds.has(msg.id)) return;
  renderedIds.add(msg.id);

  // Hide the empty-state placeholder once we have at least one message.
  emptyState.hidden = true;

  const li = createMessageElement(msg);
  if (!animate) {
    li.style.animation = 'none';
  }
  messageList.appendChild(li);

  // Scroll to the newest message.
  li.scrollIntoView({ behavior: animate ? 'smooth' : 'instant', block: 'end' });
}

/**
 * Update the connection status badge in the header.
 * @param {'connecting'|'connected'|'error'} state
 * @param {string} [label]
 */
function setStatus(state, label) {
  statusEl.className = `status status--${state}`;
  statusLabel.textContent = label ?? (
    state === 'connected'  ? 'Live'        :
    state === 'connecting' ? 'Connecting…' :
                             'Disconnected'
  );
}

// ── 1. Load message history ────────────────────────────────────────────────

async function loadHistory() {
  try {
    const res = await fetch(MESSAGES_EP);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();

    if (messages.length === 0) {
      emptyState.hidden = false;
    } else {
      messages.forEach((msg) => appendMessage(msg, false /* no animation for history */));
    }
  } catch (err) {
    console.error('[history] failed to load messages:', err);
    emptyState.hidden = false;
    emptyState.textContent = '⚠️ Could not load messages. Is the server running?';
  }
}

// ── 2. SSE connection ──────────────────────────────────────────────────────

function connectSSE() {
  setStatus('connecting');

  const es = new EventSource(STREAM_EP);

  es.addEventListener('connected', () => {
    setStatus('connected', 'Live');
    console.log('[sse] stream connected');
  });

  es.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      appendMessage(msg, true /* animate new messages */);
    } catch (err) {
      console.error('[sse] failed to parse message event:', err);
    }
  });

  es.addEventListener('error', () => {
    setStatus('error', 'Reconnecting…');
    console.warn('[sse] connection error – browser will retry automatically');
  });

  // The browser automatically reconnects EventSource on error; when it does,
  // the 'connected' event will fire again and reset the status badge.
  return es;
}

// ── 3. Form submission ─────────────────────────────────────────────────────

composeForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = messageInput.value.trim();
  if (!text) return;

  // Disable the form while the request is in-flight.
  sendBtn.disabled = true;
  messageInput.disabled = true;

  try {
    const res = await fetch(MESSAGES_EP, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }

    // Clear the input on success.
    // The SSE broadcast will add the message to the list; we do NOT append it
    // here to avoid duplicates (the server echoes it back via SSE).
    messageInput.value = '';
  } catch (err) {
    console.error('[post] failed to send message:', err);
    alert(`Failed to send message: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
    messageInput.disabled = false;
    messageInput.focus();
  }
});

// ── Bootstrap ──────────────────────────────────────────────────────────────

(async () => {
  await loadHistory();
  connectSSE();
})();
