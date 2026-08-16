/**
 * Message Board — Frontend Entry Point
 *
 * Responsibilities:
 *  1. Fetch message history on load and render it.
 *  2. Open an SSE connection and append incoming messages in real-time.
 *  3. Handle form submission (POST /api/messages) and clear the input.
 */

const API_BASE = 'http://localhost:3001';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const feed        = /** @type {HTMLUListElement}   */ (document.getElementById('feed'));
const feedEmpty   = /** @type {HTMLDivElement}     */ (document.getElementById('feedEmpty'));
const composeForm = /** @type {HTMLFormElement}    */ (document.getElementById('composeForm'));
const messageInput= /** @type {HTMLInputElement}   */ (document.getElementById('messageInput'));
const submitBtn   = /** @type {HTMLButtonElement}  */ (document.getElementById('submitBtn'));
const composeError= /** @type {HTMLParagraphElement}*/(document.getElementById('composeError'));
const statusBadge = /** @type {HTMLSpanElement}    */ (document.getElementById('statusBadge'));
const statusLabel = /** @type {HTMLSpanElement}    */ (document.getElementById('statusLabel'));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Format an ISO timestamp into a human-readable local time string.
 * @param {string} iso
 * @returns {string}
 */
function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month:  'short',
    day:    'numeric',
    hour:   '2-digit',
    minute: '2-digit',
  });
}

/**
 * Build and return a <li> element for a single message.
 * @param {{ id: number, text: string, created_at: string }} msg
 * @param {boolean} [isNew=false]  - highlight newly arrived messages
 * @returns {HTMLLIElement}
 */
function createMessageEl(msg, isNew = false) {
  const li = document.createElement('li');
  li.className = 'message' + (isNew ? ' message--new' : '');
  li.dataset.id = String(msg.id);

  const textEl = document.createElement('p');
  textEl.className = 'message__text';
  textEl.textContent = msg.text;

  const metaEl = document.createElement('div');
  metaEl.className = 'message__meta';

  const timeEl = document.createElement('time');
  timeEl.className = 'message__time';
  timeEl.dateTime = msg.created_at;
  timeEl.textContent = formatTime(msg.created_at);

  metaEl.appendChild(timeEl);

  if (isNew) {
    const badge = document.createElement('span');
    badge.className = 'message__badge';
    badge.textContent = 'new';
    metaEl.appendChild(badge);

    // Remove the "new" highlight after a short delay
    setTimeout(() => {
      li.classList.remove('message--new');
      badge.remove();
    }, 4000);
  }

  li.appendChild(textEl);
  li.appendChild(metaEl);
  return li;
}

/**
 * Append a message element to the feed and update empty-state visibility.
 * @param {{ id: number, text: string, created_at: string }} msg
 * @param {boolean} [isNew=false]
 */
function appendMessage(msg, isNew = false) {
  // Avoid duplicates (SSE may fire for a message we just POSTed)
  if (feed.querySelector(`[data-id="${msg.id}"]`)) return;

  feedEmpty.classList.add('hidden');
  const el = createMessageEl(msg, isNew);
  feed.appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * Update the connection status badge in the header.
 * @param {'connecting'|'connected'|'error'} state
 */
function setStatus(state) {
  statusBadge.classList.remove('is-connected', 'is-error');
  if (state === 'connected') {
    statusBadge.classList.add('is-connected');
    statusLabel.textContent = 'Live';
  } else if (state === 'error') {
    statusBadge.classList.add('is-error');
    statusLabel.textContent = 'Disconnected';
  } else {
    statusLabel.textContent = 'Connecting…';
  }
}

/**
 * Show or hide the compose error message.
 * @param {string|null} msg
 */
function setError(msg) {
  if (msg) {
    composeError.textContent = msg;
    composeError.hidden = false;
  } else {
    composeError.hidden = true;
    composeError.textContent = '';
  }
}

// ── 1. Load message history ───────────────────────────────────────────────────
async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();

    if (messages.length === 0) {
      feedEmpty.classList.remove('hidden');
    } else {
      feedEmpty.classList.add('hidden');
      messages.forEach(msg => appendMessage(msg, false));
    }
  } catch (err) {
    console.error('[history] failed to load:', err);
    feedEmpty.classList.remove('hidden');
  }
}

// ── 2. SSE — real-time updates ────────────────────────────────────────────────
function connectSSE() {
  setStatus('connecting');
  const es = new EventSource(`${API_BASE}/api/stream`);

  es.addEventListener('new-message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      appendMessage(msg, true);
    } catch (err) {
      console.error('[sse] failed to parse message:', err);
    }
  });

  es.addEventListener('open', () => {
    setStatus('connected');
  });

  es.addEventListener('error', () => {
    setStatus('error');
    // EventSource will automatically attempt to reconnect
  });
}

// ── 3. Form submission ────────────────────────────────────────────────────────
composeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  setError(null);

  const text = messageInput.value.trim();
  if (!text) return;

  submitBtn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/messages`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }

    // Clear the input on success; the SSE broadcast will add the message to the feed
    messageInput.value = '';
  } catch (err) {
    console.error('[post] failed:', err);
    setError(err.message || 'Failed to send message. Please try again.');
  } finally {
    submitBtn.disabled = false;
    messageInput.focus();
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
loadHistory();
connectSSE();
