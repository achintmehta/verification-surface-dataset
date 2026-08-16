// The Vite dev server proxies `/api` requests to the Node backend, and in
// production both are served from the same origin, so we can always use
// same-origin relative paths.
const API_BASE = '';

const messagesEl = document.getElementById('messages');
const formEl = document.getElementById('message-form');
const inputEl = document.getElementById('message-input');

// Track rendered message ids to avoid duplicate rendering (e.g. when the
// poster also receives their own message back via SSE).
const renderedIds = new Set();

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function renderMessage(message) {
  if (message == null || renderedIds.has(message.id)) return;
  renderedIds.add(message.id);

  const li = document.createElement('li');
  li.className = 'message';

  const text = document.createElement('span');
  text.className = 'message-text';
  text.textContent = message.text;

  const time = document.createElement('time');
  time.className = 'message-time';
  time.textContent = formatTime(message.created_at);

  li.appendChild(text);
  li.appendChild(time);
  messagesEl.appendChild(li);

  // Keep the newest message in view.
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach(renderMessage);
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

function connectStream() {
  const source = new EventSource(`${API_BASE}/api/stream`);

  source.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      renderMessage(message);
    } catch (err) {
      console.error('Failed to parse SSE message:', err);
    }
  };

  source.onerror = () => {
    // EventSource auto-reconnects; nothing to do here beyond logging.
    console.warn('SSE connection lost, attempting to reconnect…');
  };
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  try {
    const res = await fetch(`${API_BASE}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    inputEl.value = '';
    inputEl.focus();
  } catch (err) {
    console.error('Failed to send message:', err);
  }
});

loadHistory().then(connectStream);
