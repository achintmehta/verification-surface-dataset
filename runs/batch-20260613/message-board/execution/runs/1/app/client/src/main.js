/**
 * Message Board – frontend entry point
 *
 * Responsibilities:
 *  1. Fetch message history from GET /api/messages on load.
 *  2. Connect to the SSE stream at GET /api/stream and append new messages.
 *  3. Handle form submission via POST /api/messages.
 */

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const messageList  = /** @type {HTMLUListElement}   */ (document.getElementById('message-list'));
const emptyState   = /** @type {HTMLParagraphElement}*/ (document.getElementById('empty-state'));
const postForm     = /** @type {HTMLFormElement}     */ (document.getElementById('post-form'));
const messageInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('message-input'));
const submitBtn    = /** @type {HTMLButtonElement}   */ (document.getElementById('submit-btn'));
const charCount    = /** @type {HTMLSpanElement}     */ (document.getElementById('char-count'));
const formError    = /** @type {HTMLParagraphElement}*/ (document.getElementById('form-error'));
const statusBadge  = /** @type {HTMLSpanElement}     */ (document.getElementById('status'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a UTC timestamp string into a human-readable local time.
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
  metaEl.textContent = formatDate(message.created_at);

  li.appendChild(textEl);
  li.appendChild(metaEl);
  return li;
}

/**
 * Append a message element to the list and scroll to the bottom.
 * Also hides the empty-state placeholder if visible.
 * @param {{ id: number, text: string, created_at: string }} message
 */
function appendMessage(message) {
  // Avoid duplicates (e.g. if the POST response races with the SSE event)
  if (messageList.querySelector(`[data-id="${message.id}"]`)) return;

  emptyState.hidden = true;
  const li = createMessageElement(message);
  messageList.appendChild(li);

  // Scroll to the newest message
  messageList.scrollTop = messageList.scrollHeight;
}

/**
 * Show or hide the empty-state placeholder based on whether the list is empty.
 */
function syncEmptyState() {
  emptyState.hidden = messageList.childElementCount > 0;
}

// ---------------------------------------------------------------------------
// SSE status badge helpers
// ---------------------------------------------------------------------------
function setStatus(state) {
  statusBadge.className = `status status--${state}`;
  const labels = {
    connecting: '● Connecting…',
    connected:  '● Live',
    error:      '● Disconnected',
  };
  statusBadge.textContent = labels[state] ?? state;
}

// ---------------------------------------------------------------------------
// 1. Load message history
// ---------------------------------------------------------------------------
async function loadHistory() {
  try {
    const res = await fetch('/api/messages');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach(appendMessage);
    syncEmptyState();
  } catch (err) {
    console.error('[history] Failed to load messages:', err);
    // Non-fatal – the SSE stream will still deliver new messages
  }
}

// ---------------------------------------------------------------------------
// 2. SSE connection
// ---------------------------------------------------------------------------
function connectSSE() {
  setStatus('connecting');

  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => {
    setStatus('connected');
  });

  // Listen for the custom "new-message" event emitted by the server
  source.addEventListener('new-message', (event) => {
    try {
      const message = JSON.parse(event.data);
      appendMessage(message);
    } catch (err) {
      console.error('[sse] Failed to parse message event:', err);
    }
  });

  source.addEventListener('error', () => {
    setStatus('error');
    // EventSource will automatically attempt to reconnect; update badge when it does
    source.addEventListener('open', () => setStatus('connected'), { once: true });
  });
}

// ---------------------------------------------------------------------------
// 3. Character counter
// ---------------------------------------------------------------------------
const MAX_LENGTH = 2000;

messageInput.addEventListener('input', () => {
  const len = messageInput.value.length;
  charCount.textContent = `${len} / ${MAX_LENGTH}`;

  charCount.classList.remove('char-count--warn', 'char-count--limit');
  if (len >= MAX_LENGTH) {
    charCount.classList.add('char-count--limit');
  } else if (len >= MAX_LENGTH * 0.85) {
    charCount.classList.add('char-count--warn');
  }
});

// ---------------------------------------------------------------------------
// 4. Form submission
// ---------------------------------------------------------------------------

/**
 * Show an inline error message below the form.
 * @param {string} message
 */
function showFormError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function clearFormError() {
  formError.textContent = '';
  formError.hidden = true;
}

postForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFormError();

  const text = messageInput.value.trim();
  if (!text) {
    showFormError('Please enter a message before sending.');
    messageInput.focus();
    return;
  }

  // Disable the form while the request is in-flight
  submitBtn.disabled = true;
  messageInput.disabled = true;

  try {
    const res = await fetch('/api/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Server error ${res.status}`);
    }

    // Clear the input on success; the SSE broadcast will add the message to the list
    messageInput.value = '';
    charCount.textContent = `0 / ${MAX_LENGTH}`;
    charCount.classList.remove('char-count--warn', 'char-count--limit');
  } catch (err) {
    console.error('[form] Failed to post message:', err);
    showFormError(err.message ?? 'Failed to send message. Please try again.');
  } finally {
    submitBtn.disabled = false;
    messageInput.disabled = false;
    messageInput.focus();
  }
});

// Allow Ctrl+Enter / Cmd+Enter to submit the form from the textarea
messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    postForm.requestSubmit();
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
(async () => {
  await loadHistory();
  connectSSE();
  messageInput.focus();
})();
