/**
 * Message Board – frontend entry point
 *
 * Responsibilities:
 *  1. Fetch message history from GET /api/messages on load.
 *  2. Open an SSE connection to GET /api/stream and append new messages live.
 *  3. Submit new messages via POST /api/messages and clear the input.
 */

const API_BASE = '/api';

// ── DOM references ────────────────────────────────────────────────────────────
const messageList  = /** @type {HTMLUListElement}   */ (document.getElementById('message-list'));
const emptyState   = /** @type {HTMLParagraphElement}*/ (document.getElementById('empty-state'));
const postForm     = /** @type {HTMLFormElement}    */ (document.getElementById('post-form'));
const messageInput = /** @type {HTMLInputElement}   */ (document.getElementById('message-input'));
const submitBtn    = /** @type {HTMLButtonElement}  */ (postForm.querySelector('button[type="submit"]'));
const formError    = /** @type {HTMLParagraphElement}*/ (document.getElementById('form-error'));
const statusBadge  = /** @type {HTMLSpanElement}    */ (document.getElementById('status'));

// ── Helpers ───────────────────────────────────────────────────────────────────

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
 * Build and return a <li> element for a single message.
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
 * Append a message to the list and hide the empty-state placeholder.
 * Scrolls the list to the bottom so the newest message is always visible.
 * @param {{ id: number, text: string, created_at: string }} message
 */
function appendMessage(message) {
  emptyState.classList.add('hidden');
  const li = createMessageElement(message);
  messageList.appendChild(li);
  // Scroll to the bottom of the feed
  messageList.scrollTop = messageList.scrollHeight;
}

/**
 * Show or clear the inline form error.
 * @param {string} [msg]
 */
function setFormError(msg = '') {
  formError.textContent = msg;
}

/**
 * Update the SSE status badge.
 * @param {'connecting' | 'connected' | 'error'} state
 */
function setStatus(state) {
  statusBadge.className = `status status--${state}`;
  const labels = {
    connecting: '● Connecting…',
    connected:  '● Live',
    error:      '● Disconnected',
  };
  statusBadge.textContent = labels[state] ?? state;
}

// ── 1. Load message history ───────────────────────────────────────────────────

async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    /** @type {Array<{ id: number, text: string, created_at: string }>} */
    const messages = await res.json();

    if (messages.length > 0) {
      // Render all historical messages without animation delay
      messages.forEach(appendMessage);
    }
  } catch (err) {
    console.error('[history] failed to load messages:', err);
    setFormError('Could not load message history. Please refresh the page.');
  }
}

// ── 2. SSE – real-time updates ────────────────────────────────────────────────

/**
 * Track message IDs we have already rendered so that we never display a
 * duplicate if the server echoes back a message we just posted.
 * @type {Set<number>}
 */
const renderedIds = new Set();

function connectSSE() {
  setStatus('connecting');

  const es = new EventSource(`${API_BASE}/stream`);

  es.addEventListener('message', (event) => {
    try {
      /** @type {{ id: number, text: string, created_at: string }} */
      const message = JSON.parse(event.data);

      // Avoid duplicates: the POST response already rendered this message
      if (renderedIds.has(message.id)) return;

      renderedIds.add(message.id);
      appendMessage(message);
    } catch (err) {
      console.error('[sse] failed to parse message event:', err);
    }
  });

  es.addEventListener('open', () => {
    setStatus('connected');
    console.log('[sse] connection established');
  });

  es.addEventListener('error', () => {
    setStatus('error');
    console.warn('[sse] connection lost – browser will retry automatically');
  });
}

// ── 3. Post a new message ─────────────────────────────────────────────────────

postForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setFormError();

  const text = messageInput.value.trim();

  if (!text) {
    setFormError('Please enter a message before sending.');
    messageInput.focus();
    return;
  }

  // Disable the form while the request is in flight
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

    /** @type {{ id: number, text: string, created_at: string }} */
    const newMessage = await res.json();

    // Mark as rendered so the SSE broadcast doesn't duplicate it
    renderedIds.add(newMessage.id);
    appendMessage(newMessage);

    // Clear the input on success
    messageInput.value = '';
  } catch (err) {
    console.error('[post] failed to send message:', err);
    setFormError(err.message || 'Failed to send message. Please try again.');
  } finally {
    submitBtn.disabled = false;
    messageInput.disabled = false;
    messageInput.focus();
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

(async () => {
  await loadHistory();

  // Seed the renderedIds set with IDs already in the DOM so SSE doesn't
  // duplicate messages that arrived during the history fetch
  for (const li of messageList.querySelectorAll('.message-item[data-id]')) {
    renderedIds.add(Number(li.dataset.id));
  }

  connectSSE();
})();
