// Vanilla JS frontend for the realtime message board.
// - Loads message history via GET /api/messages
// - Subscribes to GET /api/stream (SSE) for live updates
// - Posts new messages via POST /api/messages

const messagesEl = document.getElementById('messages');
const emptyEl = document.getElementById('empty');
const formEl = document.getElementById('form');
const inputEl = document.getElementById('input');
const sendEl = document.getElementById('send');
const statusEl = document.getElementById('status');
const statusLabel = statusEl.querySelector('.status__label');

// Track rendered message ids to avoid duplicates (e.g. if the SSE event
// for a message we just posted arrives after the POST response).
const seenIds = new Set();

function setStatus(state, label) {
  statusEl.className = `status status--${state}`;
  statusLabel.textContent = label;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function updateEmptyState() {
  emptyEl.hidden = seenIds.size > 0;
}

function renderMessage(message) {
  if (seenIds.has(message.id)) return;
  seenIds.add(message.id);

  const li = document.createElement('li');
  li.className = 'message';
  li.dataset.id = String(message.id);

  const text = document.createElement('p');
  text.className = 'message__text';
  text.textContent = message.text;

  const time = document.createElement('time');
  time.className = 'message__time';
  time.dateTime = message.created_at;
  time.textContent = formatTime(message.created_at);

  li.append(text, time);
  messagesEl.appendChild(li);

  // Keep the latest message in view.
  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateEmptyState();
}

async function loadHistory() {
  try {
    const res = await fetch('/api/messages');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach(renderMessage);
    updateEmptyState();
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

function connectStream() {
  const source = new EventSource('/api/stream');

  source.addEventListener('ready', () => setStatus('online', 'live'));
  source.addEventListener('message', (event) => {
    try {
      renderMessage(JSON.parse(event.data));
    } catch (err) {
      console.error('Bad SSE payload:', err);
    }
  });

  source.onopen = () => setStatus('online', 'live');
  source.onerror = () => {
    // EventSource auto-reconnects; reflect the transient state.
    setStatus('offline', 'reconnecting…');
  };
}

async function submitMessage(text) {
  const res = await fetch('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Render immediately from the response for snappy UX; the SSE event for
  // this message will be deduplicated by id.
  renderMessage(await res.json());
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  sendEl.disabled = true;
  try {
    await submitMessage(text);
    inputEl.value = '';
  } catch (err) {
    console.error('Failed to send message:', err);
    alert('Could not send message. Please try again.');
  } finally {
    sendEl.disabled = false;
    inputEl.focus();
  }
});

// Bootstrap: load history first, then open the live stream. The stream is
// opened on the next tick so the initial render (and any automated page
// load that waits for network idle) isn't blocked by the long-lived SSE
// connection.
setStatus('connecting', 'connecting…');
loadHistory().finally(() => {
  setTimeout(connectStream, 0);
});
