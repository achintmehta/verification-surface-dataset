const messagesEl = document.querySelector('#messages');
const formEl = document.querySelector('#messageForm');
const inputEl = document.querySelector('#messageInput');
const statusEl = document.querySelector('#connectionStatus');

const renderedMessageIds = new Set();

function setStatus(label, modifier) {
  statusEl.textContent = label;
  statusEl.className = `status status--${modifier}`;
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function renderEmptyState() {
  if (messagesEl.children.length > 0) return;
  const empty = document.createElement('li');
  empty.className = 'messages__empty';
  empty.dataset.empty = 'true';
  empty.textContent = 'No messages yet. Be the first to post.';
  messagesEl.append(empty);
}

function removeEmptyState() {
  messagesEl.querySelector('[data-empty="true"]')?.remove();
}

function appendMessage(message) {
  if (!message || renderedMessageIds.has(message.id)) return;

  removeEmptyState();
  renderedMessageIds.add(message.id);

  const item = document.createElement('li');
  item.className = 'message';

  const text = document.createElement('p');
  text.className = 'message__text';
  text.textContent = message.text;

  const time = document.createElement('time');
  time.className = 'message__time';
  time.dateTime = message.created_at;
  time.textContent = formatTimestamp(message.created_at);

  item.append(text, time);
  messagesEl.append(item);
  item.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

async function loadHistory() {
  const response = await fetch('/api/messages');
  if (!response.ok) throw new Error('Could not load messages.');

  const messages = await response.json();
  messages.forEach(appendMessage);
  renderEmptyState();
}

function connectStream() {
  const stream = new EventSource('/api/stream');

  stream.addEventListener('ready', () => {
    setStatus('Live', 'live');
  });

  stream.addEventListener('message', (event) => {
    appendMessage(JSON.parse(event.data));
  });

  stream.addEventListener('error', () => {
    setStatus('Reconnecting…', 'connecting');
  });
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  const submitButton = formEl.querySelector('button');
  submitButton.disabled = true;

  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Could not post message.');
    }

    inputEl.value = '';
    inputEl.focus();
  } catch (error) {
    alert(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

loadHistory()
  .catch((error) => {
    console.error(error);
    renderEmptyState();
  })
  .finally(connectStream);
