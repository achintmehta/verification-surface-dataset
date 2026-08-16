import './style.css';

const messagesEl = document.getElementById('messages');
const emptyEl = document.getElementById('empty');
const formEl = document.getElementById('composer');
const inputEl = document.getElementById('text');
const sendBtn = document.getElementById('send');
const statusEl = document.getElementById('status');
const statusText = statusEl.querySelector('.status-text');

// Track rendered message ids to avoid duplicates (e.g. POST response + SSE echo).
const seenIds = new Set();

function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusText.textContent = text;
}

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
  text.className = 'message-text';
  text.textContent = message.text;

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = formatTime(message.created_at);

  li.append(text, meta);
  messagesEl.append(li);
  updateEmptyState();

  // Keep the newest message in view.
  messagesEl.scrollTop = messagesEl.scrollHeight;
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

  source.addEventListener('open', () => setStatus('connected', 'Live'));

  source.addEventListener('message', (event) => {
    try {
      renderMessage(JSON.parse(event.data));
    } catch (err) {
      console.error('Bad SSE payload:', err);
    }
  });

  source.addEventListener('error', () => {
    // EventSource auto-reconnects; reflect the transient state.
    setStatus('disconnected', 'Reconnecting…');
  });
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  sendBtn.disabled = true;
  try {
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const message = await res.json();
    // Render immediately for snappy UX; SSE echo is de-duplicated.
    renderMessage(message);

    inputEl.value = '';
    inputEl.focus();
  } catch (err) {
    console.error('Failed to send message:', err);
    alert('Failed to send message. Please try again.');
  } finally {
    sendBtn.disabled = false;
  }
});

setStatus('connecting', 'Connecting…');
loadHistory();

// Open the long-lived SSE connection after the page has finished loading so the
// initial render isn't blocked by the persistent stream.
function start() {
  // A tiny delay lets the browser settle the navigation before we open the
  // never-ending EventSource request.
  setTimeout(connectStream, 100);
}

if (document.readyState === 'complete') {
  start();
} else {
  window.addEventListener('load', start, { once: true });
}
