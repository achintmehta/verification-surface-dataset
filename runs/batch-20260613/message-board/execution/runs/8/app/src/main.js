import './style.css';

const messagesEl = document.querySelector('#messages');
const formEl = document.querySelector('#message-form');
const inputEl = document.querySelector('#message-input');
const statusEl = document.querySelector('#status');
const emptyStateEl = document.querySelector('#empty-state');
const messageCountEl = document.querySelector('#message-count');

const seenMessageIds = new Set();
let messageCount = 0;

function setStatus(text, variant = 'info') {
  statusEl.textContent = text;
  statusEl.dataset.variant = variant;
}

function formatTimestamp(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function updateEmptyState() {
  emptyStateEl.hidden = messageCount > 0;
  messageCountEl.textContent = String(messageCount);
}

function appendMessage(message) {
  if (!message || seenMessageIds.has(message.id)) {
    return;
  }

  seenMessageIds.add(message.id);
  messageCount += 1;

  const item = document.createElement('li');
  item.className = 'message';
  item.dataset.messageId = message.id;

  const text = document.createElement('p');
  text.className = 'message-text';
  text.textContent = message.text;

  const meta = document.createElement('time');
  meta.className = 'message-time';
  meta.dateTime = message.created_at ?? '';
  meta.textContent = formatTimestamp(message.created_at);

  item.append(text, meta);
  messagesEl.append(item);
  item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  updateEmptyState();
}

async function loadMessageHistory() {
  const response = await fetch('/api/messages');

  if (!response.ok) {
    throw new Error('Could not load message history.');
  }

  const messages = await response.json();
  messages.forEach(appendMessage);
  updateEmptyState();
}

function connectToMessageStream() {
  const events = new EventSource('/api/stream');

  events.addEventListener('open', () => {
    setStatus('Connected. New messages appear automatically.', 'success');
  });

  events.addEventListener('message', (event) => {
    try {
      appendMessage(JSON.parse(event.data));
    } catch (error) {
      console.error('Invalid SSE payload:', error);
    }
  });

  events.addEventListener('error', () => {
    setStatus('Connection interrupted. Reconnecting…', 'warning');
  });

  return events;
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = inputEl.value.trim();
  if (!text) {
    inputEl.focus();
    return;
  }

  const submitButton = formEl.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Could not post message.');
    }

    inputEl.value = '';
    inputEl.focus();
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    submitButton.disabled = false;
  }
});

async function start() {
  try {
    await loadMessageHistory();
    connectToMessageStream();
  } catch (error) {
    console.error(error);
    setStatus(error.message, 'error');
  }
}

start();
