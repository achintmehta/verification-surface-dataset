import './styles.css';

const messagesEl = document.querySelector('#messages');
const formEl = document.querySelector('#message-form');
const inputEl = document.querySelector('#message-input');
const statusEl = document.querySelector('#connection-status');

const renderedMessageIds = new Set();

function setStatus(label, state) {
  statusEl.textContent = label;
  statusEl.className = `status status--${state}`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric'
  }).format(date);
}

function createMessageNode(message) {
  const item = document.createElement('li');
  item.className = 'message';
  item.dataset.messageId = message.id;

  const text = document.createElement('p');
  text.className = 'message__text';
  text.textContent = message.text;

  const time = document.createElement('time');
  time.className = 'message__time';
  time.dateTime = message.created_at;
  time.textContent = formatTime(message.created_at);

  item.append(text, time);
  return item;
}

function renderEmptyState() {
  if (messagesEl.children.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = 'No messages yet. Be the first to post!';
    messagesEl.append(empty);
  }
}

function removeEmptyState() {
  const empty = messagesEl.querySelector('.empty-state');
  empty?.remove();
}

function appendMessage(message) {
  if (!message || renderedMessageIds.has(message.id)) return;

  removeEmptyState();
  renderedMessageIds.add(message.id);
  messagesEl.append(createMessageNode(message));
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadMessages() {
  const response = await fetch('/api/messages');
  if (!response.ok) throw new Error('Failed to load messages');

  const messages = await response.json();
  messagesEl.replaceChildren();
  renderedMessageIds.clear();
  messages.forEach(appendMessage);
  renderEmptyState();
}

function connectStream() {
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => {
    setStatus('Live', 'live');
  });

  source.addEventListener('ready', () => {
    setStatus('Live', 'live');
  });

  source.addEventListener('message', (event) => {
    try {
      appendMessage(JSON.parse(event.data));
    } catch (error) {
      console.error('Could not parse SSE message', error);
    }
  });

  source.addEventListener('error', () => {
    setStatus('Reconnecting…', 'connecting');
  });
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = inputEl.value.trim();
  if (!text) return;

  const submitButton = formEl.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to post message');
    }

    appendMessage(await response.json());
    inputEl.value = '';
    inputEl.focus();
  } catch (error) {
    console.error(error);
    alert(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

loadMessages()
  .catch((error) => {
    console.error(error);
    messagesEl.replaceChildren();
    const item = document.createElement('li');
    item.className = 'empty-state empty-state--error';
    item.textContent = 'Could not load messages. Is the server running?';
    messagesEl.append(item);
  })
  .finally(connectStream);
