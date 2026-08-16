/**
 * Message Board — Frontend entry point
 *
 * Responsibilities:
 *  1. Fetch message history on load and render it.
 *  2. Open an SSE connection and append incoming messages in real-time.
 *  3. Handle form submission (POST /api/messages) and clear the input.
 */

const API_BASE = 'http://localhost:3001';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const feed        = /** @type {HTMLUListElement}   */ (document.getElementById('message-feed'));
const feedEmpty   = /** @type {HTMLDivElement}     */ (document.getElementById('feed-empty'));
const statusBadge = /** @type {HTMLSpanElement}    */ (document.getElementById('status-badge'));
const statusLabel = /** @type {HTMLSpanElement}    */ (statusBadge.querySelector('.status-label'));
const form        = /** @type {HTMLFormElement}    */ (document.getElementById('compose-form'));
const input       = /** @type {HTMLInputElement}   */ (document.getElementById('message-input'));
const hint        = /** @type {HTMLParagraphElement}*/ (document.getElementById('compose-hint'));
const sendBtn     = /** @type {HTMLButtonElement}  */ (form.querySelector('.compose__btn'));

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
 * @param {boolean} [isNew=false]  Highlight the card briefly if true.
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

  const idEl = document.createElement('span');
  idEl.className = 'message__id';
  idEl.textContent = `#${msg.id}`;

  metaEl.append(timeEl, idEl);
  li.append(textEl, metaEl);

  // Remove the "new" highlight after the animation settles
  if (isNew) {
    setTimeout(() => li.classList.remove('message--new'), 2000);
  }

  return li;
}

/**
 * Append a message element to the feed and scroll it into view.
 * Also hides the empty-state placeholder.
 * @param {{ id: number, text: string, created_at: string }} msg
 * @param {boolean} [isNew=false]
 */
function appendMessage(msg, isNew = false) {
  feedEmpty.hidden = true;
  const el = createMessageEl(msg, isNew);
  feed.appendChild(el);
  el.scrollIntoView({ behavior: isNew ? 'smooth' : 'instant', block: 'nearest' });
}

/**
 * Update the connection status badge.
 * @param {'connecting'|'live'|'error'} state
 * @param {string} label
 */
function setStatus(state, label) {
  statusBadge.dataset.state = state;
  statusLabel.textContent = label;
}

/**
 * Show a transient hint message below the compose form.
 * @param {string} text
 * @param {'error'|'success'} type
 * @param {number} [duration=3000]
 */
function showHint(text, type, duration = 3000) {
  hint.textContent = text;
  hint.className = `compose__hint compose__hint--${type}`;
  hint.hidden = false;
  clearTimeout(hint._timer);
  hint._timer = setTimeout(() => { hint.hidden = true; }, duration);
}

// ── 1. Load message history ───────────────────────────────────────────────────

async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();

    if (messages.length === 0) {
      feedEmpty.hidden = false;
    } else {
      messages.forEach((msg) => appendMessage(msg, false));
    }
  } catch (err) {
    console.error('[history] failed to load:', err);
    feedEmpty.hidden = false;
    showHint('Could not load message history. Is the server running?', 'error', 8000);
  }
}

// ── 2. SSE connection ─────────────────────────────────────────────────────────

function connectSSE() {
  setStatus('connecting', 'Connecting…');

  const es = new EventSource(`${API_BASE}/api/stream`);

  es.addEventListener('connected', () => {
    setStatus('live', 'Live');
    console.log('[sse] connected');
  });

  es.addEventListener('new-message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      appendMessage(msg, true);
    } catch (err) {
      console.error('[sse] failed to parse message:', err);
    }
  });

  es.onerror = () => {
    setStatus('error', 'Reconnecting…');
    console.warn('[sse] connection error — browser will retry automatically');
  };

  // EventSource reconnects automatically; update status when it does
  es.onopen = () => {
    setStatus('live', 'Live');
  };
}

// ── 3. Form submission ────────────────────────────────────────────────────────

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  sendBtn.disabled = true;
  input.disabled   = true;

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
    input.value = '';
  } catch (err) {
    console.error('[post] failed:', err);
    showHint(`Failed to send: ${err.message}`, 'error');
  } finally {
    sendBtn.disabled = false;
    input.disabled   = false;
    input.focus();
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
loadHistory();
connectSSE();
