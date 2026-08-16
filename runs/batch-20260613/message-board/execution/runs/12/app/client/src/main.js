import './style.css';

const messagesEl = document.getElementById('messages');
const formEl = document.getElementById('form');
const inputEl = document.getElementById('input');
const buttonEl = formEl.querySelector('button');
const statusEl = document.getElementById('status');

// Track rendered message ids to avoid duplicates (e.g. our own POST + SSE echo).
const seenIds = new Set();

/** Format a timestamp into a short, human readable string. */
function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function setStatus(state, label) {
  statusEl.className = `status status--${state}`;
  statusEl.textContent = label;
}

function clearEmptyState() {
  const empty = messagesEl.querySelector('.empty');
  if (empty) empty.remove();
}

function showEmptyState() {
  if (messagesEl.children.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No messages yet. Be the first to post!';
    messagesEl.appendChild(li);
  }
}

/** Render a single message and append it to the list (deduplicated). */
function renderMessage(message) {
  if (message == null || seenIds.has(message.id)) return;
  seenIds.add(message.id);
  clearEmptyState();

  const li = document.createElement('li');
  li.className = 'message';
  li.dataset.id = String(message.id);

  const text = document.createElement('div');
  text.className = 'message__text';
  text.textContent = message.text;

  const time = document.createElement('time');
  time.className = 'message__time';
  time.textContent = formatTime(message.created_at);
  if (message.created_at) time.dateTime = message.created_at;

  li.append(text, time);
  messagesEl.appendChild(li);

  // Keep the latest message in view.
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** Fetch the message history for the initial render. */
async function loadHistory() {
  try {
    const res = await fetch('/api/messages');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach(renderMessage);
    showEmptyState();
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

/** Connect to the SSE stream and listen for new messages. */
function connectStream() {
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => setStatus('online', 'online'));

  source.addEventListener('message', (event) => {
    try {
      renderMessage(JSON.parse(event.data));
    } catch (err) {
      console.error('Failed to parse SSE message:', err);
    }
  });

  source.addEventListener('error', () => {
    // EventSource auto-reconnects; reflect the transient state in the UI.
    setStatus('offline', 'reconnecting…');
  });

  return source;
}

/** Submit handler: POST the message and clear the input. */
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

    // Render our own message immediately for snappy UX. The SSE echo is
    // deduplicated by id, so this is safe.
    const message = await res.json();
    renderMessage(message);

    inputEl.value = '';
  } catch (err) {
    console.error('Failed to send message:', err);
    alert('Could not send your message. Please try again.');
  } finally {
    buttonEl.disabled = false;
    inputEl.focus();
  }
});

// Boot the app.
setStatus('connecting', 'connecting…');
loadHistory().finally(connectStream);
