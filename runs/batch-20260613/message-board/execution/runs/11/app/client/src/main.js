// Realtime Message Board — frontend logic.
//
// Responsibilities:
//   - Load message history on page load (GET /api/messages)
//   - Subscribe to live updates via SSE (GET /api/stream)
//   - Post new messages (POST /api/messages) and clear the input
//
// API requests use relative URLs; Vite proxies `/api` to the backend in dev,
// and in production the backend can serve the built assets on the same origin.

const messagesEl = document.getElementById('messages');
const emptyEl = document.getElementById('empty');
const formEl = document.getElementById('message-form');
const inputEl = document.getElementById('message-input');
const buttonEl = formEl.querySelector('button');
const statusEl = document.getElementById('status');

// Track rendered message ids to avoid duplicates (e.g. the SSE echo of a
// message we may also have rendered optimistically, or reconnect overlaps).
const seenIds = new Set();

function setStatus(state) {
  const labels = {
    connecting: 'connecting…',
    live: 'live',
    offline: 'offline',
  };
  statusEl.className = `status status--${state}`;
  statusEl.textContent = labels[state] ?? state;
}

function updateEmptyState() {
  emptyEl.hidden = seenIds.size > 0;
}

function formatTime(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Render a single message into the DOM (appended at the bottom).
 * Returns false if the message was already rendered.
 */
function renderMessage(message, { scroll = true } = {}) {
  if (message == null || message.id == null) return false;
  if (seenIds.has(message.id)) return false;
  seenIds.add(message.id);

  const li = document.createElement('li');
  li.className = 'message';
  li.dataset.id = String(message.id);

  const text = document.createElement('p');
  text.className = 'message__text';
  text.textContent = message.text; // textContent prevents HTML injection.

  const time = document.createElement('time');
  time.className = 'message__time';
  if (message.created_at) {
    time.dateTime = message.created_at;
    time.textContent = formatTime(message.created_at);
  }

  li.append(text, time);
  messagesEl.append(li);

  updateEmptyState();

  if (scroll) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  return true;
}

/**
 * Load historical messages and render them in order.
 */
async function loadHistory() {
  try {
    const res = await fetch('/api/messages');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    for (const message of messages) {
      renderMessage(message, { scroll: false });
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } catch (err) {
    console.error('Failed to load message history:', err);
  } finally {
    updateEmptyState();
  }
}

/**
 * Open the SSE connection and wire up live message events.
 */
function connectStream() {
  setStatus('connecting');
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => setStatus('live'));

  source.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      renderMessage(message);
    } catch (err) {
      console.error('Failed to parse SSE message:', err);
    }
  });

  source.addEventListener('error', () => {
    // EventSource auto-reconnects; reflect the transient state.
    setStatus('offline');
  });

  return source;
}

/**
 * Handle form submission: POST the message and clear the input.
 * The new message is rendered when it echoes back over SSE.
 */
async function handleSubmit(event) {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  buttonEl.disabled = true;
  try {
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Render immediately for snappy feedback; SSE echo will be de-duped.
    const message = await res.json();
    renderMessage(message);

    inputEl.value = '';
    inputEl.focus();
  } catch (err) {
    console.error('Failed to send message:', err);
  } finally {
    buttonEl.disabled = false;
  }
}

formEl.addEventListener('submit', handleSubmit);

// Boot the app.
loadHistory();
connectStream();
