/**
 * Realtime Board frontend.
 *
 * - Loads message history via `GET /api/messages`.
 * - Subscribes to live updates via `GET /api/stream` (Server-Sent Events).
 * - Posts new messages via `POST /api/messages`.
 */

const messagesEl = document.getElementById('messages');
const formEl = document.getElementById('composer');
const inputEl = document.getElementById('input');
const buttonEl = formEl.querySelector('button');
const statusEl = document.getElementById('status');

// Track rendered message ids so the SSE stream never duplicates a message we
// already rendered (e.g. the optimistic echo of our own POST).
const seen = new Set();

/**
 * Render a single message into the DOM if it has not been rendered already.
 * @param {{ id: number, text: string, created_at: string }} message
 */
function renderMessage(message) {
  if (seen.has(message.id)) return;
  seen.add(message.id);

  const li = document.createElement('li');
  li.className = 'message';
  li.dataset.id = String(message.id);

  const text = document.createElement('p');
  text.className = 'message__text';
  text.textContent = message.text;

  const time = document.createElement('time');
  time.className = 'message__time';
  const date = new Date(message.created_at);
  time.dateTime = date.toISOString();
  time.textContent = date.toLocaleString();

  li.append(text, time);
  messagesEl.append(li);

  // Keep the newest message in view.
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** Set the connection status pill. */
function setStatus(label, state) {
  statusEl.textContent = label;
  statusEl.className = `status status--${state}`;
}

/** Fetch and render the full message history. */
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

/** Connect to the SSE stream and append live messages. */
function connectStream() {
  setStatus('connecting…', 'connecting');
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => setStatus('live', 'connected'));

  source.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      renderMessage(message);
    } catch (err) {
      console.error('Failed to parse SSE message:', err);
    }
  });

  source.addEventListener('error', () => {
    // EventSource auto-reconnects; reflect the transient state in the UI.
    setStatus('reconnecting…', 'error');
  });
}

/** Handle form submission: POST the message and clear the input. */
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

    // The message will arrive through the SSE stream too; renderMessage
    // dedupes by id so rendering here keeps the UI snappy without duplicates.
    const message = await res.json();
    renderMessage(message);

    inputEl.value = '';
  } catch (err) {
    console.error('Failed to send message:', err);
  } finally {
    buttonEl.disabled = false;
    inputEl.focus();
  }
});

// Bootstrap: load history first, then subscribe to live updates.
loadHistory().then(connectStream);
