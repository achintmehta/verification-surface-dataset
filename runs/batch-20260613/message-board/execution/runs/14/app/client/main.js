// Realtime Board frontend — Vanilla JS.
// Fetches historical messages, listens for live updates over SSE, and posts
// new messages via HTTP. Renders everything into a simple message list.

const messagesEl = document.getElementById('messages');
const emptyEl = document.getElementById('empty');
const statusEl = document.getElementById('status');
const formEl = document.getElementById('composer');
const inputEl = document.getElementById('text');
const sendEl = document.getElementById('send');

// Track rendered message ids to avoid duplicates (e.g. SSE echo of own post).
const seen = new Set();

function setStatus(state, label) {
  statusEl.className = `status status--${state}`;
  statusEl.textContent = label;
}

function updateEmptyState() {
  emptyEl.classList.toggle('hidden', messagesEl.children.length > 0);
}

function formatTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

function renderMessage(message, { prepend = false } = {}) {
  if (message == null || message.id == null) return;
  if (seen.has(message.id)) return;
  seen.add(message.id);

  const li = document.createElement('li');
  li.className = 'message';
  li.dataset.id = String(message.id);

  const text = document.createElement('p');
  text.className = 'message__text';
  text.textContent = message.text; // textContent prevents HTML/script injection.

  const time = document.createElement('time');
  time.className = 'message__time';
  time.dateTime = message.created_at;
  time.textContent = formatTime(message.created_at);

  li.append(text, time);

  if (prepend) {
    messagesEl.prepend(li);
  } else {
    messagesEl.append(li);
  }

  updateEmptyState();
}

function scrollToBottom() {
  const main = messagesEl.closest('main');
  if (main) main.scrollTop = main.scrollHeight;
}

// 1) Load history on initial page load.
async function loadHistory() {
  try {
    const res = await fetch('/api/messages');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    for (const message of messages) renderMessage(message);
    scrollToBottom();
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

// 2) Connect to the SSE stream for live updates.
function connectStream() {
  setStatus('connecting', 'connecting…');
  const source = new EventSource('/api/stream');

  source.addEventListener('connected', () => {
    setStatus('online', 'online');
  });

  source.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      const wasAtBottom = isScrolledToBottom();
      renderMessage(message);
      if (wasAtBottom) scrollToBottom();
    } catch (err) {
      console.error('Bad SSE payload:', err);
    }
  });

  source.onopen = () => setStatus('online', 'online');

  source.onerror = () => {
    // EventSource auto-reconnects; reflect the transient state in the UI.
    setStatus('offline', 'reconnecting…');
  };
}

function isScrolledToBottom() {
  const main = messagesEl.closest('main');
  if (!main) return true;
  return main.scrollHeight - main.scrollTop - main.clientHeight < 60;
}

// 3) Handle form submission to post a new message.
formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  sendEl.disabled = true;
  try {
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    // The message will arrive via SSE and be rendered there.
    inputEl.value = '';
  } catch (err) {
    console.error('Failed to post message:', err);
    alert(`Could not post message: ${err.message}`);
  } finally {
    sendEl.disabled = false;
    inputEl.focus();
  }
});

// Boot.
loadHistory().finally(connectStream);
