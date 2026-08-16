// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// When served from the same origin as the API (Express), use '' for relative paths.
// When using Vite dev server with proxy, relative paths also work.
const API_BASE = '';

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const messagesList = document.getElementById('messages');
const form = document.getElementById('message-form');
const input = document.getElementById('message-input');
const status = document.getElementById('connection-status');

// Set of IDs already rendered (prevents duplicates from SSE + POST response)
const renderedIds = new Set();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO timestamp into a friendly locale string.
 */
function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Create a <li> element for a message and append it to the list.
 * Scrolls to the bottom so the newest message is always visible.
 */
function appendMessage(msg) {
  if (renderedIds.has(msg.id)) return;
  renderedIds.add(msg.id);

  // Remove empty state placeholder if present
  const empty = messagesList.querySelector('.empty-state');
  if (empty) empty.remove();

  const li = document.createElement('li');

  const textSpan = document.createElement('span');
  textSpan.className = 'msg-text';
  textSpan.textContent = msg.text;

  const timeSpan = document.createElement('span');
  timeSpan.className = 'msg-time';
  timeSpan.textContent = formatTime(msg.created_at);

  li.appendChild(textSpan);
  li.appendChild(timeSpan);
  messagesList.appendChild(li);

  // Auto-scroll to bottom
  const main = messagesList.closest('main');
  main.scrollTop = main.scrollHeight;
}

/**
 * Show an empty-state placeholder when there are no messages.
 */
function showEmptyState() {
  const li = document.createElement('li');
  li.className = 'empty-state';
  li.textContent = 'No messages yet — be the first to post!';
  messagesList.appendChild(li);
}

// ---------------------------------------------------------------------------
// Fetch initial message history
// ---------------------------------------------------------------------------
async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();

    if (messages.length === 0) {
      showEmptyState();
    } else {
      messages.forEach(appendMessage);
    }
  } catch (err) {
    console.error('Failed to load message history:', err);
  }
}

// ---------------------------------------------------------------------------
// SSE – Real-time stream
// ---------------------------------------------------------------------------
function connectSSE() {
  const es = new EventSource(`${API_BASE}/api/stream`);

  es.addEventListener('new-message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      appendMessage(msg);
    } catch (err) {
      console.error('Failed to parse SSE message:', err);
    }
  });

  es.addEventListener('open', () => {
    status.textContent = 'Connected';
    status.className = 'status connected';
  });

  es.addEventListener('error', () => {
    status.textContent = 'Disconnected';
    status.className = 'status disconnected';
    // EventSource automatically reconnects; we just update UI status.
  });
}

// ---------------------------------------------------------------------------
// Form submission – POST new message
// ---------------------------------------------------------------------------
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  // Optimistically clear the input
  input.value = '';
  input.focus();

  try {
    const res = await fetch(`${API_BASE}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }

    // The SSE stream will deliver the message; we don't need to append here
    // since broadcast() fires for all clients including the sender.
    // However, if SSE hasn't delivered it yet, the POST response gives us
    // the message so we can show it immediately:
    const msg = await res.json();
    appendMessage(msg);
  } catch (err) {
    console.error('Failed to send message:', err);
    // Restore text so the user can retry
    input.value = text;
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadHistory();
connectSSE();
