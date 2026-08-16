import './style.css';

const messagesEl = document.getElementById('messages');
const emptyEl = document.getElementById('empty');
const statusEl = document.getElementById('status');
const formEl = document.getElementById('composer');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');

// Track ids we've already rendered so optimistic posts and SSE echoes don't
// produce duplicates.
const seenIds = new Set();

/** Update the connection status pill. */
function setStatus(state, label) {
  statusEl.className = `status status--${state}`;
  statusEl.textContent = label;
}

/** Toggle the empty-state hint based on rendered message count. */
function refreshEmptyState() {
  emptyEl.hidden = messagesEl.children.length > 0;
}

/** Format an ISO/SQL timestamp into a readable local time string. */
function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Render a single message and append it to the list. */
function renderMessage(msg) {
  if (msg == null || seenIds.has(msg.id)) return;
  seenIds.add(msg.id);

  const li = document.createElement('li');
  li.className = 'message';
  li.dataset.id = String(msg.id);

  const text = document.createElement('p');
  text.className = 'message__text';
  text.textContent = msg.text;

  const time = document.createElement('time');
  time.className = 'message__time';
  time.textContent = formatTime(msg.created_at);

  li.append(text, time);
  messagesEl.appendChild(li);
  refreshEmptyState();

  // Keep the newest message in view.
  li.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

/** Load the message history for the initial render. */
async function loadHistory() {
  try {
    const res = await fetch('/api/messages');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach(renderMessage);
  } catch (err) {
    console.error('Failed to load history:', err);
  }
  refreshEmptyState();
}

/** Open the SSE connection and wire up live updates. */
function connectStream() {
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => setStatus('online', 'live'));

  source.addEventListener('message', (event) => {
    try {
      renderMessage(JSON.parse(event.data));
    } catch (err) {
      console.error('Bad SSE payload:', err);
    }
  });

  source.addEventListener('error', () => {
    // EventSource auto-reconnects; reflect the transient state in the UI.
    setStatus('offline', 'reconnecting…');
  });
}

/** Send a new message to the backend. */
async function sendMessage(text) {
  const res = await fetch('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  // The broadcast over SSE will render the message for us (including for the
  // sender), so we don't render it here to avoid duplicates.
  return res.json();
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  sendBtn.disabled = true;
  try {
    await sendMessage(text);
    inputEl.value = '';
  } catch (err) {
    console.error('Failed to send message:', err);
    alert(`Could not send message: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
    inputEl.focus();
  }
});

// Bootstrap: history first, then live stream.
setStatus('connecting', 'connecting…');
loadHistory().then(connectStream);
