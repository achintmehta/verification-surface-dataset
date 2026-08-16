// Realtime Message Board — frontend logic.
// - Loads message history via GET /api/messages
// - Subscribes to live updates via SSE (GET /api/stream)
// - Posts new messages via POST /api/messages

const els = {
  messages: document.getElementById('messages'),
  empty: document.getElementById('empty'),
  form: document.getElementById('form'),
  input: document.getElementById('input'),
  button: document.querySelector('.composer__button'),
  status: document.getElementById('status'),
};

// Track rendered message ids to avoid duplicates (e.g. our own POST that also
// comes back over the SSE stream).
const seenIds = new Set();

function setStatus(state, label) {
  els.status.className = `status status--${state}`;
  els.status.textContent = label;
}

function updateEmptyState() {
  els.empty.hidden = els.messages.children.length > 0;
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Render a single message and append it to the bottom of the list.
 * @param {{id:number, text:string, created_at:string}} msg
 */
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
  time.dateTime = msg.created_at;
  time.textContent = formatTime(msg.created_at);

  li.append(text, time);
  els.messages.appendChild(li);
  updateEmptyState();

  // Keep the newest message in view.
  els.messages.scrollTop = els.messages.scrollHeight;
}

/** Load historical messages on initial page load. */
async function loadHistory() {
  try {
    const res = await fetch('/api/messages');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach(renderMessage);
    updateEmptyState();
  } catch (err) {
    console.error('Failed to load message history:', err);
  }
}

/** Connect to the SSE stream and react to incoming `message` events. */
function connectStream() {
  setStatus('connecting', 'connecting…');
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => setStatus('online', 'live'));

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

/** Handle posting new messages. */
els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;

  els.button.disabled = true;
  try {
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Render immediately for snappy feedback; the SSE echo will be de-duped.
    const msg = await res.json();
    renderMessage(msg);

    els.input.value = '';
  } catch (err) {
    console.error('Failed to post message:', err);
    alert('Could not send message. Please try again.');
  } finally {
    els.button.disabled = false;
    els.input.focus();
  }
});

// Boot.
loadHistory();
connectStream();
