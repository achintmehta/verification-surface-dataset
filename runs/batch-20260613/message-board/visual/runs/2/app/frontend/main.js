/**
 * Message Board – Frontend entry point
 *
 * Responsibilities:
 *  1. Fetch message history on load and render it.
 *  2. Open an SSE connection and append incoming messages in real-time.
 *  3. Handle form submission (POST /api/messages) and clear the input.
 */

// When served from the same Express server, use a relative path.
// When running via Vite dev server (port 5173), Vite proxies /api → :3001.
const API_BASE = '/api';

/* ── DOM references ───────────────────────────────────────────── */
const feed        = /** @type {HTMLElement} */ (document.getElementById('feed'));
const feedEmpty   = /** @type {HTMLElement} */ (document.getElementById('feed-empty'));
const form        = /** @type {HTMLFormElement} */ (document.getElementById('compose-form'));
const input       = /** @type {HTMLTextAreaElement} */ (document.getElementById('message-input'));
const sendBtn     = /** @type {HTMLButtonElement} */ (document.getElementById('send-btn'));
const statusBadge = /** @type {HTMLElement} */ (document.getElementById('status-badge'));
const composeErr  = /** @type {HTMLElement} */ (document.getElementById('compose-error'));
const charCounter = /** @type {HTMLElement} */ (document.getElementById('char-counter'));

/* ── Helpers ──────────────────────────────────────────────────── */

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
 * Escape HTML special characters to prevent XSS.
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
 * Build and insert a message element into the feed.
 *
 * @param {{ id: number, text: string, created_at: string }} msg
 * @param {boolean} [isNew=false]  – if true, apply the "new" highlight style
 */
function renderMessage(msg, isNew = false) {
  // Hide the empty-state placeholder
  feedEmpty.style.display = 'none';

  const article = document.createElement('article');
  article.className = 'message' + (isNew ? ' message--new' : '');
  article.dataset.id = String(msg.id);

  article.innerHTML = `
    <div class="message__bubble">${escapeHtml(msg.text)}</div>
    <time class="message__time" datetime="${escapeHtml(msg.created_at)}">
      ${formatTime(msg.created_at)}
    </time>
  `;

  feed.appendChild(article);

  // Remove the "new" highlight after the animation settles
  if (isNew) {
    setTimeout(() => article.classList.remove('message--new'), 2500);
  }
}

/** Scroll the feed to the very bottom. */
function scrollToBottom() {
  feed.scrollTop = feed.scrollHeight;
}

/* ── 1. Load message history ──────────────────────────────────── */
async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach((m) => renderMessage(m, false));
    scrollToBottom();
  } catch (err) {
    console.error('[history] failed to load:', err);
    feedEmpty.textContent = '⚠️ Could not load messages. Is the server running?';
    feedEmpty.style.display = '';
  }
}

/* ── 2. SSE connection ────────────────────────────────────────── */
function connectSSE() {
  const es = new EventSource(`${API_BASE}/stream`);

  es.addEventListener('open', () => {
    setStatus('connected');
  });

  es.addEventListener('new-message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      renderMessage(msg, true);
      scrollToBottom();
    } catch (err) {
      console.error('[sse] failed to parse message:', err);
    }
  });

  es.addEventListener('error', () => {
    setStatus('error');
    // EventSource will automatically attempt to reconnect
  });
}

/**
 * Update the connection status badge.
 * @param {'connecting'|'connected'|'error'} state
 */
function setStatus(state) {
  const labels = {
    connecting: 'connecting…',
    connected:  '● live',
    error:      '✕ reconnecting…',
  };
  statusBadge.textContent = labels[state] ?? state;
  statusBadge.className = 'header__badge ' + (state === 'connected' ? 'connected' : state === 'error' ? 'error' : '');
}

/* ── 3. Form submission ───────────────────────────────────────── */
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  composeErr.textContent = '';

  const text = input.value.trim();
  if (!text) {
    composeErr.textContent = 'Please enter a message.';
    input.focus();
    return;
  }

  sendBtn.disabled = true;
  sendBtn.querySelector('.compose__btn-text').textContent = 'Sending…';

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

    // Clear the input on success
    input.value = '';
    updateCounter();
    input.focus();
  } catch (err) {
    console.error('[post] failed:', err);
    composeErr.textContent = err.message ?? 'Failed to send message.';
  } finally {
    sendBtn.disabled = false;
    sendBtn.querySelector('.compose__btn-text').textContent = 'Send';
  }
});

/* ── Character counter ────────────────────────────────────────── */
function updateCounter() {
  const len = input.value.length;
  const max = 2000;
  charCounter.textContent = `${len} / ${max}`;
  charCounter.className = 'compose__counter' +
    (len > max * 0.9 ? (len >= max ? ' danger' : ' warn') : '');
}

input.addEventListener('input', updateCounter);

// Allow Ctrl+Enter / Cmd+Enter to submit
input.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    form.requestSubmit();
  }
});

/* ── Bootstrap ────────────────────────────────────────────────── */
setStatus('connecting');
loadHistory();
connectSSE();
