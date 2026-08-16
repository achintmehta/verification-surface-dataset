const messagesEl = document.getElementById('messages');
const emptyStateEl = document.getElementById('empty-state');
const formEl = document.getElementById('composer');
const inputEl = document.getElementById('text');
const buttonEl = formEl.querySelector('button');
const statusEl = document.getElementById('status');

// Track rendered message ids to avoid duplicates (e.g. POST response + SSE echo).
const renderedIds = new Set();

/** Updates the connection status pill. */
function setStatus(state, label) {
  statusEl.className = `status status--${state}`;
  statusEl.textContent = label;
}

/** Formats an ISO timestamp into a short, human-readable string. */
function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Renders a single message into the DOM if it hasn't been rendered already.
 * @param {{ id: number, text: string, created_at: string }} message
 */
function renderMessage(message) {
  if (renderedIds.has(message.id)) return;
  renderedIds.add(message.id);

  if (emptyStateEl) emptyStateEl.remove();

  const item = document.createElement('li');
  item.className = 'messages__item';
  item.dataset.id = String(message.id);

  const text = document.createElement('div');
  text.className = 'messages__text';
  text.textContent = message.text;

  const time = document.createElement('time');
  time.className = 'messages__time';
  time.dateTime = message.created_at;
  time.textContent = formatTime(message.created_at);

  item.append(text, time);
  messagesEl.append(item);

  // Keep the newest message in view.
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** Loads the message history and renders it. */
async function loadHistory() {
  try {
    const res = await fetch('/api/messages');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach(renderMessage);
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

/** Opens the SSE stream and wires up reconnection-aware status updates. */
function connectStream() {
  setStatus('connecting', 'connecting…');
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => setStatus('live', 'live'));

  source.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      renderMessage(message);
    } catch (err) {
      console.error('Failed to parse SSE message:', err);
    }
  });

  source.addEventListener('error', () => {
    // EventSource auto-reconnects; reflect the transient offline state.
    setStatus('offline', 'reconnecting…');
  });
}

/** Handles posting a new message. */
formEl.addEventListener('submit', async (event) => {
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

    const message = await res.json();
    // Render immediately for snappy UX; SSE echo will be de-duplicated.
    renderMessage(message);

    inputEl.value = '';
    inputEl.focus();
  } catch (err) {
    console.error('Failed to send message:', err);
  } finally {
    buttonEl.disabled = false;
  }
});

loadHistory().then(connectStream);
