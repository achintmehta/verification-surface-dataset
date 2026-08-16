const messagesEl = document.getElementById('messages');
const formEl = document.getElementById('message-form');
const inputEl = document.getElementById('message-input');
const statusEl = document.getElementById('status');

// Track rendered message ids to avoid duplicates (e.g. POST response + SSE).
const seenIds = new Set();

function setStatus(state, label) {
  statusEl.textContent = label;
  statusEl.className = `status status--${state}`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function renderMessage(message) {
  if (message == null || seenIds.has(message.id)) return;
  seenIds.add(message.id);

  const li = document.createElement('li');
  li.className = 'message';
  li.dataset.id = String(message.id);

  const text = document.createElement('div');
  text.className = 'message__text';
  text.textContent = message.text;

  const time = document.createElement('span');
  time.className = 'message__time';
  time.textContent = formatTime(message.created_at);

  li.append(text, time);
  messagesEl.appendChild(li);

  // Keep the newest message in view.
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

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

function connectStream() {
  setStatus('connecting', 'connecting…');
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => setStatus('connected', 'live'));

  source.addEventListener('message', (event) => {
    try {
      renderMessage(JSON.parse(event.data));
    } catch (err) {
      console.error('Failed to parse SSE message:', err);
    }
  });

  source.addEventListener('error', () => {
    setStatus('disconnected', 'reconnecting…');
    // EventSource reconnects automatically; status updates on next open.
  });
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  inputEl.value = '';
  inputEl.focus();

  try {
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Render immediately; SSE broadcast will be de-duplicated by seenIds.
    renderMessage(await res.json());
  } catch (err) {
    console.error('Failed to send message:', err);
    inputEl.value = text; // restore on failure
  }
});

loadHistory();
connectStream();
