const messagesEl = document.getElementById('messages');
const formEl = document.getElementById('message-form');
const inputEl = document.getElementById('message-input');
const statusEl = document.getElementById('status');

// Track rendered message ids to avoid duplicates (e.g. SSE echo of own post).
const seen = new Set();

function setStatus(state, label) {
  statusEl.className = `status status--${state}`;
  statusEl.textContent = label;
}

function formatTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

function renderMessage(message, { prepend = false } = {}) {
  if (seen.has(message.id)) return;
  seen.add(message.id);

  const li = document.createElement('li');
  li.className = 'message';
  li.dataset.id = String(message.id);

  const text = document.createElement('span');
  text.className = 'message__text';
  text.textContent = message.text;

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

  // Keep the newest message in view.
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadHistory() {
  try {
    const res = await fetch('/api/messages');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach((m) => renderMessage(m));
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

function connectStream() {
  const source = new EventSource('/api/stream');

  source.addEventListener('connected', () => setStatus('live', 'live'));
  source.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      renderMessage(message);
    } catch (err) {
      console.error('Bad SSE payload:', err);
    }
  });

  source.onopen = () => setStatus('live', 'live');
  source.onerror = () => setStatus('connecting', 'reconnecting…');
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
    // The new message is delivered back to us through the SSE stream,
    // so no manual render is needed here.
  } catch (err) {
    console.error('Failed to send message:', err);
    // Restore text so the user does not lose their input.
    inputEl.value = text;
  }
});

// Bootstrap: load existing messages, then subscribe for live updates.
setStatus('connecting', 'connecting…');
loadHistory().then(connectStream);
