/**
 * Message Board – frontend entry point
 *
 * Responsibilities:
 *  1. Fetch historical messages on load and render them.
 *  2. Open an SSE connection and append incoming messages in real-time.
 *  3. Handle form submission (POST /api/messages) and clear the input.
 */

const API_BASE = 'http://localhost:3001';

// ─── DOM References ───────────────────────────────────────────────────────────
const messageList  = /** @type {HTMLUListElement}   */ (document.getElementById('messageList'));
const emptyState   = /** @type {HTMLDivElement}     */ (document.getElementById('emptyState'));
const loadingState = /** @type {HTMLDivElement}     */ (document.getElementById('loadingState'));
const composeForm  = /** @type {HTMLFormElement}    */ (document.getElementById('composeForm'));
const messageInput = /** @type {HTMLTextAreaElement}*/ (document.getElementById('messageInput'));
const charCount    = /** @type {HTMLSpanElement}    */ (document.getElementById('charCount'));
const statusEl     = /** @type {HTMLSpanElement}    */ (document.getElementById('status'));
const statusLabel  = statusEl.querySelector('.status__label');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format a UTC timestamp into a human-readable local time string.
 * @param {string} isoString
 */
function formatTime(isoString) {
  const d = new Date(isoString);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60_000);

  if (diffMins < 1)  return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Derive a short display name and avatar letter from a message id.
 * Since we have no auth, we generate a deterministic pseudonym from the id.
 * @param {number} id
 */
function pseudonym(id) {
  const names = [
    'Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank',
    'Grace', 'Hank', 'Iris', 'Jack', 'Kara', 'Leo',
    'Mia', 'Nate', 'Olivia', 'Pete', 'Quinn', 'Rosa',
    'Sam', 'Tara', 'Uma', 'Vince', 'Wendy', 'Xena',
    'Yara', 'Zoe',
  ];
  return names[id % names.length];
}

/**
 * Build and return a <li> element for a message.
 * @param {{ id: number, text: string, created_at: string }} msg
 * @param {boolean} [isNew]
 */
function createMessageEl(msg, isNew = false) {
  const name   = pseudonym(msg.id);
  const letter = name[0].toUpperCase();
  const time   = formatTime(msg.created_at);

  const li = document.createElement('li');
  li.className = 'message' + (isNew ? ' message--new' : '');
  li.dataset.id = String(msg.id);

  li.innerHTML = `
    <div class="message__avatar" aria-hidden="true">${letter}</div>
    <div class="message__body">
      <div class="message__meta">
        <span class="message__author">${escapeHtml(name)}</span>
        <time class="message__time" datetime="${escapeHtml(msg.created_at)}">${escapeHtml(time)}</time>
      </div>
      <p class="message__text">${escapeHtml(msg.text)}</p>
    </div>
  `;

  // Remove the "new" highlight after the animation settles
  if (isNew) {
    setTimeout(() => li.classList.remove('message--new'), 2500);
  }

  return li;
}

/** Minimal HTML escaping to prevent XSS. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Scroll the feed to the bottom. */
function scrollToBottom() {
  const feed = messageList.closest('.feed');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

/** Show / hide the empty-state placeholder. */
function syncEmptyState() {
  emptyState.hidden = messageList.children.length > 0;
}

// ─── Status Indicator ─────────────────────────────────────────────────────────

/**
 * @param {'connecting'|'connected'|'error'} state
 * @param {string} [label]
 */
function setStatus(state, label) {
  statusEl.className = `header__status ${state}`;
  statusLabel.textContent = label ?? {
    connecting: 'Connecting…',
    connected:  'Live',
    error:      'Disconnected',
  }[state];
}

// ─── 1. Load Historical Messages ──────────────────────────────────────────────

async function loadHistory() {
  loadingState.hidden = false;
  emptyState.hidden   = true;

  try {
    const res = await fetch(`${API_BASE}/api/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    /** @type {Array<{id:number, text:string, created_at:string}>} */
    const messages = await res.json();

    loadingState.hidden = true;

    if (messages.length === 0) {
      emptyState.hidden = false;
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const msg of messages) {
      fragment.appendChild(createMessageEl(msg, false));
    }
    messageList.appendChild(fragment);

    syncEmptyState();
    scrollToBottom();
  } catch (err) {
    loadingState.hidden = true;
    emptyState.hidden   = false;
    console.error('[history] failed to load messages:', err);
  }
}

// ─── 2. SSE – Real-time Updates ───────────────────────────────────────────────

/** IDs of messages we already rendered (prevents duplicates if SSE fires for
 *  a message we just POSTed and the server echoes it back). */
const renderedIds = new Set();

function initSSE() {
  setStatus('connecting');

  const es = new EventSource(`${API_BASE}/api/stream`);

  es.addEventListener('open', () => {
    setStatus('connected');
  });

  es.addEventListener('message', (event) => {
    try {
      /** @type {{id:number, text:string, created_at:string}} */
      const msg = JSON.parse(event.data);

      // Avoid duplicates
      if (renderedIds.has(msg.id)) return;
      renderedIds.add(msg.id);

      const li = createMessageEl(msg, true);
      messageList.appendChild(li);
      syncEmptyState();
      scrollToBottom();
    } catch (err) {
      console.error('[sse] failed to parse message:', err);
    }
  });

  es.addEventListener('error', () => {
    setStatus('error', 'Reconnecting…');
    // EventSource auto-reconnects; update label when it opens again
  });
}

// ─── 3. Compose Form ──────────────────────────────────────────────────────────

// Character counter
messageInput.addEventListener('input', () => {
  const len = messageInput.value.length;
  charCount.textContent = `${len} / 2000`;
  charCount.className = 'compose__char-count' +
    (len >= 2000 ? ' limit' : len >= 1800 ? ' warn' : '');
});

// Ctrl+Enter shortcut
messageInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    composeForm.requestSubmit();
  }
});

composeForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const text = messageInput.value.trim();
  if (!text) return;

  const submitBtn = composeForm.querySelector('.compose__btn');
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

    // The server will broadcast via SSE; we mark the id as already-rendered
    // so the SSE handler skips it (avoids duplicate rendering).
    const created = await res.json();
    renderedIds.add(created.id);

    // Optimistically render immediately for the sender
    const li = createMessageEl(created, true);
    messageList.appendChild(li);
    syncEmptyState();
    scrollToBottom();

    // Clear the input
    messageInput.value = '';
    charCount.textContent = '0 / 2000';
    charCount.className = 'compose__char-count';
    messageInput.focus();
  } catch (err) {
    console.error('[post] failed to send message:', err);
    alert(`Failed to send message: ${err.message}`);
  } finally {
    submitBtn.disabled = false;
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

(async () => {
  await loadHistory();

  // Seed renderedIds with already-displayed messages so SSE doesn't duplicate
  for (const li of messageList.querySelectorAll('[data-id]')) {
    renderedIds.add(Number(li.dataset.id));
  }

  initSSE();
})();
