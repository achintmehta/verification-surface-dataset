// Realtime Message Board — frontend logic.
// Uses fetch for initial state + posting, and EventSource (SSE) for live updates.

const API = '/api';

const els = {
  messages: document.getElementById('messages'),
  empty: document.getElementById('empty'),
  form: document.getElementById('composer'),
  input: document.getElementById('text'),
  send: document.getElementById('send'),
  status: document.getElementById('status'),
};

// Track rendered message ids to avoid duplicates (e.g. echo of own message).
const seen = new Set();

function setStatus(state, label) {
  els.status.className = `status status--${state}`;
  els.status.textContent = label;
}

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

function updateEmptyState() {
  els.empty.classList.toggle('hidden', seen.size > 0);
}

/**
 * Render a single message into the DOM, keeping the feed scrolled to bottom
 * if the user is already near the bottom.
 */
function renderMessage(msg) {
  if (msg == null || seen.has(msg.id)) return;
  seen.add(msg.id);

  const nearBottom =
    els.messages.scrollHeight - els.messages.parentElement.scrollTop <=
    els.messages.parentElement.clientHeight + 120;

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
  els.messages.appendChild(li);

  updateEmptyState();

  if (nearBottom) {
    els.messages.parentElement.scrollTop = els.messages.parentElement.scrollHeight;
  }
}

/** Load historical messages on initial page load. */
async function loadHistory() {
  try {
    const res = await fetch(`${API}/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach(renderMessage);
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

/** Connect to the SSE stream and append messages as they arrive. */
function connectStream() {
  setStatus('connecting', 'connecting…');
  const source = new EventSource(`${API}/stream`);

  source.addEventListener('open', () => {
    setStatus('connected', 'live');
  });

  source.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      renderMessage(msg);
    } catch (err) {
      console.error('Bad SSE payload:', err);
    }
  });

  source.addEventListener('error', () => {
    // EventSource auto-reconnects; reflect the transient state.
    setStatus('disconnected', 'reconnecting…');
  });
}

/** Wire up the form to POST new messages and clear the input. */
function setupComposer() {
  els.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = els.input.value.trim();
    if (!text) return;

    els.send.disabled = true;
    try {
      const res = await fetch(`${API}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // The posted message will also arrive via SSE; render it now for
      // instant feedback (dedup handles the echo).
      const msg = await res.json();
      renderMessage(msg);

      els.input.value = '';
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      els.send.disabled = false;
      els.input.focus();
    }
  });
}

async function init() {
  setupComposer();
  await loadHistory();
  updateEmptyState();
  connectStream();
}

init();
