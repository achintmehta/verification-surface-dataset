/**
 * Message Board – frontend entry point
 *
 * Responsibilities:
 *  1. Fetch message history from GET /api/messages on load.
 *  2. Open an SSE connection to GET /api/stream and append new messages live.
 *  3. Submit new messages via POST /api/messages and clear the input.
 */

// ── DOM references ────────────────────────────────────────────────────────────
const messageList  = /** @type {HTMLUListElement}   */ (document.getElementById('message-list'));
const emptyState   = /** @type {HTMLDivElement}     */ (document.getElementById('empty-state'));
const statusBadge  = /** @type {HTMLSpanElement}    */ (document.getElementById('status'));
const composeForm  = /** @type {HTMLFormElement}    */ (document.getElementById('compose-form'));
const messageInput = /** @type {HTMLInputElement}   */ (document.getElementById('message-input'));
const submitBtn    = /** @type {HTMLButtonElement}  */ (composeForm.querySelector('button[type="submit"]'));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Format an ISO timestamp into a human-readable local time string.
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
 * @param {{ id: number, text: string, created_at: string }} message
 * @returns {HTMLLIElement}
 */
function createMessageElement(message) {
  const li = document.createElement('li');
  li.classList.add('message');
  li.dataset.id = String(message.id);

  const textEl = document.createElement('p');
  textEl.classList.add('message-text');
  textEl.textContent = message.text;

  const timeEl = document.createElement('time');
  timeEl.classList.add('message-time');
  timeEl.dateTime = message.created_at;
  timeEl.textContent = formatTime(message.created_at);

  li.appendChild(textEl);
  li.appendChild(timeEl);
  return li;
}

/**
 * Append a message element to the list and hide the empty-state placeholder.
 * Scrolls the new message into view.
 * @param {{ id: number, text: string, created_at: string }} message
 */
function appendMessage(message) {
  emptyState.hidden = true;
  const li = createMessageElement(message);
  messageList.appendChild(li);
  li.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

/**
 * Update the SSE status badge.
 * @param {'connecting' | 'connected' | 'error'} state
 * @param {string} label
 */
function setStatus(state, label) {
  statusBadge.className = `status status--${state}`;
  statusBadge.textContent = label;
}

// ── 1. Load message history ───────────────────────────────────────────────────

async function loadHistory() {
  try {
    const res = await fetch('/api/messages');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    /** @type {Array<{ id: number, text: string, created_at: string }>} */
    const messages = await res.json();

    if (messages.length === 0) {
      emptyState.hidden = false;
    } else {
      emptyState.hidden = true;
      for (const msg of messages) {
        messageList.appendChild(createMessageElement(msg));
      }
      // Scroll to the bottom after rendering history
      messageList.lastElementChild?.scrollIntoView({ block: 'end' });
    }
  } catch (err) {
    console.error('[history] Failed to load messages:', err);
    emptyState.hidden = false;
    emptyState.querySelector('p').textContent =
      'Could not load messages. Please refresh the page.';
  }
}

// ── 2. SSE connection ─────────────────────────────────────────────────────────

/**
 * Track IDs we have already rendered so that a message posted by *this* tab
 * (which we optimistically append on POST success) is not duplicated when the
 * SSE broadcast arrives.
 * @type {Set<number>}
 */
const renderedIds = new Set();

function connectSSE() {
  setStatus('connecting', '● Connecting…');

  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => {
    setStatus('connected', '● Live');
  });

  source.addEventListener('new-message', (event) => {
    /** @type {{ id: number, text: string, created_at: string }} */
    const message = JSON.parse(event.data);

    // Skip if we already rendered this message (e.g. from the POST response)
    if (renderedIds.has(message.id)) return;

    renderedIds.add(message.id);
    appendMessage(message);
  });

  source.addEventListener('error', () => {
    setStatus('error', '● Reconnecting…');
    // EventSource will automatically attempt to reconnect; we just update the UI.
  });
}

// ── 3. Form submission ────────────────────────────────────────────────────────

composeForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = messageInput.value.trim();
  if (!text) return;

  // Disable the form while the request is in-flight
  submitBtn.disabled   = true;
  messageInput.disabled = true;

  try {
    const res = await fetch('/api/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }

    /** @type {{ id: number, text: string, created_at: string }} */
    const message = await res.json();

    // Optimistically render the message immediately (before SSE echo arrives)
    renderedIds.add(message.id);
    appendMessage(message);

    // Clear the input on success
    messageInput.value = '';
  } catch (err) {
    console.error('[compose] Failed to send message:', err);
    alert(`Failed to send message: ${err.message}`);
  } finally {
    submitBtn.disabled    = false;
    messageInput.disabled = false;
    messageInput.focus();
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

loadHistory();
connectSSE();
