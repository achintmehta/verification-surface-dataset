/**
 * UI helpers – all direct DOM manipulation lives here so that main.js
 * stays focused on application logic.
 */

const feed        = /** @type {HTMLUListElement}     */ (document.getElementById('feed'));
const emptyState  = /** @type {HTMLParagraphElement} */ (document.getElementById('empty-state'));
const statusDot   = /** @type {HTMLSpanElement}      */ (document.getElementById('status-dot'));
const statusText  = /** @type {HTMLSpanElement}      */ (document.getElementById('status-text'));
const errorMsg    = /** @type {HTMLParagraphElement} */ (document.getElementById('error-msg'));
const composeBtn  = /** @type {HTMLButtonElement}    */ (document.getElementById('compose-btn'));
const feedContainer = /** @type {HTMLElement}        */ (document.getElementById('feed-container'));

/* ── Helpers ──────────────────────────────────────────────────────── */

/**
 * Format an ISO timestamp into a human-readable local time string.
 * @param {string} isoString
 */
function formatTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleString(undefined, {
    year:   'numeric',
    month:  'short',
    day:    'numeric',
    hour:   '2-digit',
    minute: '2-digit',
  });
}

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} str
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── Public API ───────────────────────────────────────────────────── */

/**
 * Build and return a <li> element for a single message.
 * @param {{ id: number, text: string, created_at: string }} message
 */
function buildMessageEl(message) {
  const li = document.createElement('li');
  li.className = 'message-card';
  li.dataset.id = String(message.id);

  li.innerHTML = `
    <p class="message-text">${escapeHtml(message.text)}</p>
    <time class="message-meta" datetime="${escapeHtml(message.created_at)}">
      ${formatTime(message.created_at)}
    </time>
  `;

  return li;
}

/**
 * Render the initial list of messages (replaces any existing content).
 * @param {Array<{id: number, text: string, created_at: string}>} messages
 */
export function renderMessages(messages) {
  feed.innerHTML = '';

  if (messages.length === 0) {
    emptyState.hidden = false;
    return;
  }

  emptyState.hidden = true;
  const fragment = document.createDocumentFragment();
  for (const msg of messages) {
    fragment.appendChild(buildMessageEl(msg));
  }
  feed.appendChild(fragment);

  scrollToBottom();
}

/**
 * Append a single new message to the feed (used for real-time updates).
 * @param {{ id: number, text: string, created_at: string }} message
 */
export function appendMessage(message) {
  // Guard: don't add a duplicate if we already rendered it
  if (feed.querySelector(`[data-id="${message.id}"]`)) return;

  emptyState.hidden = true;
  feed.appendChild(buildMessageEl(message));
  scrollToBottom();
}

/**
 * Scroll the feed container to the very bottom.
 */
export function scrollToBottom() {
  feedContainer.scrollTop = feedContainer.scrollHeight;
}

/* ── Status indicator ─────────────────────────────────────────────── */

/** @param {'connecting'|'connected'|'error'} state */
export function setStatus(state) {
  statusDot.className = 'status-dot';

  switch (state) {
    case 'connected':
      statusDot.classList.add('ok');
      statusText.textContent = 'Live';
      break;
    case 'error':
      statusDot.classList.add('error');
      statusText.textContent = 'Reconnecting…';
      break;
    default:
      statusText.textContent = 'Connecting…';
  }
}

/* ── Error message ────────────────────────────────────────────────── */

/** @param {string|null} msg – pass null to hide */
export function showError(msg) {
  if (msg) {
    errorMsg.textContent = msg;
    errorMsg.hidden = false;
  } else {
    errorMsg.textContent = '';
    errorMsg.hidden = true;
  }
}

/* ── Compose button state ─────────────────────────────────────────── */

/** @param {boolean} loading */
export function setSubmitting(loading) {
  composeBtn.disabled = loading;
  composeBtn.textContent = loading ? 'Sending…' : 'Send';
}
