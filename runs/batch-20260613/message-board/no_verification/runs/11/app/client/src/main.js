import './style.css';

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const messagesEl = document.getElementById('messages');
const emptyStateEl = document.getElementById('empty-state');
const formEl = document.getElementById('message-form');
const inputEl = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const statusEl = document.getElementById('status');

// Track which message ids are already rendered so the realtime stream never
// produces duplicates (e.g. the message we just POSTed also arrives via SSE).
const renderedIds = new Set();

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderMessage(message) {
  if (renderedIds.has(message.id)) return;
  renderedIds.add(message.id);

  // Hide the empty-state placeholder once we have real content.
  if (emptyStateEl) emptyStateEl.style.display = 'none';

  const li = document.createElement('li');
  li.className = 'message';
  li.dataset.id = String(message.id);

  const textEl = document.createElement('div');
  textEl.className = 'message__text';
  textEl.textContent = message.text;

  const timeEl = document.createElement('time');
  timeEl.className = 'message__time';
  timeEl.dateTime = message.created_at;
  timeEl.textContent = formatTime(message.created_at);

  li.append(textEl, timeEl);
  messagesEl.appendChild(li);

  // Keep the newest message in view.
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------
function setStatus(state) {
  const labels = {
    connecting: 'connecting…',
    online: 'online',
    offline: 'offline',
  };
  statusEl.textContent = labels[state] || state;
  statusEl.className = `status status--${state}`;
}

// ---------------------------------------------------------------------------
// Initial history load
// ---------------------------------------------------------------------------
async function loadHistory() {
  try {
    const res = await fetch('/api/messages');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach(renderMessage);
  } catch (err) {
    console.error('Failed to load message history:', err);
  }
}

// ---------------------------------------------------------------------------
// Realtime stream (SSE)
// ---------------------------------------------------------------------------
function connectStream() {
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => setStatus('online'));

  source.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      renderMessage(message);
    } catch (err) {
      console.error('Failed to parse incoming message:', err);
    }
  });

  source.addEventListener('error', () => {
    // EventSource reconnects automatically; reflect the transient state.
    setStatus('offline');
  });

  return source;
}

// ---------------------------------------------------------------------------
// Posting messages
// ---------------------------------------------------------------------------
async function sendMessage(text) {
  const res = await fetch('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  sendButton.disabled = true;
  try {
    const message = await sendMessage(text);
    // Render immediately for snappy UX; the SSE echo is de-duplicated.
    renderMessage(message);
    inputEl.value = '';
  } catch (err) {
    console.error('Failed to send message:', err);
    alert(`Could not send message: ${err.message}`);
  } finally {
    sendButton.disabled = false;
    inputEl.focus();
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function init() {
  setStatus('connecting');
  await loadHistory();
  connectStream();
  inputEl.focus();
}

init();
