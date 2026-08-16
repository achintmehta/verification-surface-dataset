/**
 * main.js – Message Board frontend
 *
 * Responsibilities:
 *  1. Fetch message history from GET /api/messages on load.
 *  2. Open an SSE connection to GET /api/stream and append live messages.
 *  3. Submit new messages via POST /api/messages and clear the input.
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
const errorMsg     = /** @type {HTMLParagraphElement}*/ (document.getElementById('error-msg'));

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Format an ISO timestamp into a human-readable local string.
 * @param {string} iso
 * @returns {string}
 */
function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * Build and return a <li> element for a single message.
 * @param {{ id: number, text: string, created_at: string }} msg
 * @returns {HTMLLIElement}
 */
function createMessageElement(msg) {
  const li = document.createElement('li');
  li.className = 'message-card';
  li.dataset.id = String(msg.id);

  const textEl = document.createElement('p');
  textEl.className = 'message-text';
  textEl.textContent = msg.text;

  const metaEl = document.createElement('time');
  metaEl.className = 'message-meta';
  metaEl.dateTime = msg.created_at;
  metaEl.textContent = formatDate(msg.created_at);

  li.appendChild(textEl);
  li.appendChild(metaEl);
  return li;
}

/**
 * Append a message card to the list and hide the empty-state notice.
 * Scrolls the feed to the bottom so the newest message is visible.
 * @param {{ id: number, text: string, created_at: string }} msg
 */
function appendMessage(msg) {
  // Guard: don't add duplicates (can happen if POST response races SSE).
  if (messageList.querySelector(`[data-id="${msg.id}"]`)) return;

  emptyState.classList.add('hidden');
  messageList.appendChild(createMessageElement(msg));

  // Scroll the feed wrapper to the bottom.
  const feed = messageList.closest('.feed-wrapper');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

/**
 * Update the connection status badge.
 * @param {'connecting'|'live'|'error'} state
 * @param {string} label
 */
function setStatus(state, label) {
  statusBadge.dataset.state = state;
  statusBadge.textContent = label;
}

/**
 * Show or clear the inline error message below the compose form.
 * @param {string} text
 */
function showError(text) {
  errorMsg.textContent = text;
}

function clearError() {
  errorMsg.textContent = '';
}

// ── 1. Load message history ────────────────────────────────────────────────
async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    /** @type {Array<{ id: number, text: string, created_at: string }>} */
    const messages = await res.json();

    if (messages.length === 0) {
      emptyState.classList.remove('hidden');
    } else {
      emptyState.classList.add('hidden');
      for (const msg of messages) {
        appendMessage(msg);
      }
    }
  } catch (err) {
    console.error('[history] failed to load:', err);
    showError('Could not load message history. Please refresh the page.');
  }
}

// ── 2. SSE connection ──────────────────────────────────────────────────────
function connectSSE() {
  setStatus('connecting', 'Connecting…');

  const es = new EventSource(`${API_BASE}/stream`);

  es.addEventListener('connected', () => {
    setStatus('live', '● Live');
    console.log('[sse] connected');
  });

  es.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      appendMessage(msg);
    } catch (err) {
      console.error('[sse] failed to parse message event:', err);
    }
  });

  es.addEventListener('error', () => {
    setStatus('error', 'Reconnecting…');
    console.warn('[sse] connection error – browser will retry automatically');
  });
}

// ── 3. Form submission ─────────────────────────────────────────────────────
composeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

  const text = messageInput.value.trim();
  if (!text) return;

  // Disable the form while the request is in flight.
  composeBtn.disabled = true;
  messageInput.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }

    // Clear the input on success.
    // The SSE broadcast will add the message to the list; we don't
    // manually append here to avoid duplicates.
    messageInput.value = '';
  } catch (err) {
    console.error('[post] failed to send message:', err);
    showError(err.message || 'Failed to send message. Please try again.');
  } finally {
    composeBtn.disabled = false;
    messageInput.disabled = false;
    messageInput.focus();
  }
});

// ── Bootstrap ──────────────────────────────────────────────────────────────
loadHistory();
connectSSE();
