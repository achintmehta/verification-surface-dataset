const messagesEl = document.getElementById('messages');
const formEl = document.getElementById('message-form');
const inputEl = document.getElementById('message-input');

// Track rendered message ids to avoid duplicates (e.g. POST response + SSE echo).
const seenIds = new Set();

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function renderMessage(message) {
  if (message == null || seenIds.has(message.id)) return;
  seenIds.add(message.id);

  const li = document.createElement('li');

  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = message.text;

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatTime(message.created_at);

  li.appendChild(text);
  li.appendChild(time);
  messagesEl.appendChild(li);

  // Keep the latest message in view.
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// 1. Load the message history on initial page load.
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

// 2. Connect to the SSE stream for real-time updates.
function connectStream() {
  const source = new EventSource('/api/stream');

  source.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      renderMessage(message);
    } catch (err) {
      console.error('Failed to parse SSE message:', err);
    }
  };

  source.onerror = () => {
    // EventSource auto-reconnects; just log for visibility.
    console.warn('SSE connection lost, attempting to reconnect…');
  };
}

// 3. Wire up form submission.
formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  inputEl.value = '';

  try {
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const message = await res.json();
    // Render immediately; SSE echo will be deduped via seenIds.
    renderMessage(message);
  } catch (err) {
    console.error('Failed to send message:', err);
    // Restore the input so the user can retry.
    inputEl.value = text;
  }
});

loadHistory();
connectStream();
