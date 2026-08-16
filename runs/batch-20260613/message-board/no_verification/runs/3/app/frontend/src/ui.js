/**
 * ui.js
 * Pure DOM-manipulation helpers.  No state lives here – all state is managed
 * in main.js and passed in as arguments.
 */

/* ── Element references ─────────────────────────────────────────────────── */

export const messageList  = /** @type {HTMLOListElement}    */ (document.getElementById('message-list'));
export const emptyState   = /** @type {HTMLParagraphElement}*/ (document.getElementById('empty-state'));
export const statusBadge  = /** @type {HTMLSpanElement}     */ (document.getElementById('status-badge'));
export const composeForm  = /** @type {HTMLFormElement}     */ (document.getElementById('compose-form'));
export const messageInput = /** @type {HTMLInputElement}    */ (document.getElementById('message-input'));
export const composeBtn   = /** @type {HTMLButtonElement}   */ (document.getElementById('compose-btn'));

/* ── Status badge ───────────────────────────────────────────────────────── */

/**
 * Updates the connection-status badge text and colour class.
 *
 * @param {'connecting'|'connected'|'error'} state
 */
export function setStatus(state) {
  const labels = {
    connecting: 'Connecting…',
    connected:  'Live',
    error:      'Disconnected',
  };
  statusBadge.textContent = labels[state] ?? state;
  statusBadge.className = 'status-badge';
  if (state === 'connected') statusBadge.classList.add('connected');
  if (state === 'error')     statusBadge.classList.add('error');
}

/* ── Message rendering ──────────────────────────────────────────────────── */

/**
 * Formats an ISO timestamp into a human-readable local time string.
 *
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
 * Creates a single `<li>` element for a message.
 *
 * @param {{ id: number, text: string, created_at: string }} message
 * @returns {HTMLLIElement}
 */
function createMessageElement(message) {
  const li = document.createElement('li');
  li.className = 'message-item';
  li.dataset.id = String(message.id);

  const textEl = document.createElement('p');
  textEl.className = 'message-text';
  textEl.textContent = message.text;

  const metaEl = document.createElement('time');
  metaEl.className = 'message-meta';
  metaEl.dateTime = message.created_at;
  metaEl.textContent = formatTime(message.created_at);

  li.appendChild(textEl);
  li.appendChild(metaEl);
  return li;
}

/**
 * Renders an array of messages into the list, replacing any existing content.
 * Shows the empty-state placeholder when the array is empty.
 *
 * @param {Array<{id: number, text: string, created_at: string}>} messages
 */
export function renderMessages(messages) {
  messageList.innerHTML = '';

  if (messages.length === 0) {
    emptyState.classList.add('visible');
    return;
  }

  emptyState.classList.remove('visible');
  const fragment = document.createDocumentFragment();
  for (const msg of messages) {
    fragment.appendChild(createMessageElement(msg));
  }
  messageList.appendChild(fragment);

  // Scroll to the bottom so the newest message is visible.
  scrollToBottom();
}

/**
 * Appends a single new message to the bottom of the list.
 * Hides the empty-state placeholder if it was visible.
 *
 * @param {{ id: number, text: string, created_at: string }} message
 */
export function appendMessage(message) {
  emptyState.classList.remove('visible');

  // Guard against duplicate messages (e.g. if the POST response and the SSE
  // event both try to add the same message).
  if (messageList.querySelector(`[data-id="${message.id}"]`)) return;

  messageList.appendChild(createMessageElement(message));
  scrollToBottom();
}

/* ── Scroll helper ──────────────────────────────────────────────────────── */

/**
 * Scrolls the feed to the very bottom so the latest message is visible.
 * Uses `requestAnimationFrame` to ensure the DOM has been painted first.
 */
function scrollToBottom() {
  requestAnimationFrame(() => {
    const feed = messageList.closest('.feed-wrapper');
    if (feed) feed.scrollTop = feed.scrollHeight;
  });
}

/* ── Form helpers ───────────────────────────────────────────────────────── */

/**
 * Disables the compose form while a submission is in flight.
 */
export function lockForm() {
  messageInput.disabled = true;
  composeBtn.disabled   = true;
  composeBtn.textContent = 'Sending…';
}

/**
 * Re-enables the compose form after a submission completes (success or error).
 */
export function unlockForm() {
  messageInput.disabled = false;
  composeBtn.disabled   = false;
  composeBtn.textContent = 'Send';
  messageInput.focus();
}
