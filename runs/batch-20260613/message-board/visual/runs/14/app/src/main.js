import './style.css';

// In dev, Vite serves the frontend on a different port than the API server,
// so we point at the backend directly. In production the backend serves the
// built files, so same-origin relative paths work.
const API_BASE = import.meta.env.DEV ? 'http://localhost:3001' : '';

const messagesEl = document.getElementById('messages');
const emptyEl = document.getElementById('empty');
const statusEl = document.getElementById('status');
const formEl = document.getElementById('composer');
const inputEl = document.getElementById('text');
const buttonEl = formEl.querySelector('button');

// Track rendered message ids to avoid duplicates (e.g. POST response + SSE echo).
const renderedIds = new Set();

function setStatus(state) {
  const labels = {
    connecting: 'connecting…',
    online: 'live',
    offline: 'offline'
  };
  statusEl.textContent = labels[state] || state;
  statusEl.className = `status status--${state}`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function updateEmptyState() {
  emptyEl.classList.toggle('hidden', renderedIds.size > 0);
}

function renderMessage(msg) {
  if (renderedIds.has(msg.id)) return;
  renderedIds.add(msg.id);

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

  updateEmptyState();
  // Keep the newest message in view.
  li.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// 1. Load message history on initial page load.
async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach(renderMessage);
    updateEmptyState();
  } catch (err) {
    console.error('Failed to load message history:', err);
  }
}

// 2. Subscribe to real-time updates via Server-Sent Events.
function connectStream() {
  const source = new EventSource(`${API_BASE}/api/stream`);

  source.addEventListener('open', () => setStatus('online'));

  source.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      renderMessage(msg);
    } catch (err) {
      console.error('Failed to parse SSE message:', err);
    }
  });

  source.addEventListener('error', () => {
    setStatus('offline');
    // EventSource reconnects automatically; reflect that in the UI.
    setTimeout(() => {
      if (source.readyState === EventSource.CONNECTING) setStatus('connecting');
    }, 500);
  });
}

// 3. Send new messages.
formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  buttonEl.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const msg = await res.json();
    // Render immediately for snappy UX (SSE echo is de-duplicated).
    renderMessage(msg);
    inputEl.value = '';
  } catch (err) {
    console.error('Failed to send message:', err);
  } finally {
    buttonEl.disabled = false;
    inputEl.focus();
  }
});

setStatus('connecting');
loadHistory();
connectStream();
