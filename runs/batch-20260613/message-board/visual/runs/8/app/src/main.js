import './styles.css';

const messagesEl = document.querySelector('#messages');
const emptyStateEl = document.querySelector('#empty-state');
const messageCountEl = document.querySelector('#message-count');
const formEl = document.querySelector('#message-form');
const inputEl = document.querySelector('#message-input');
const statusEl = document.querySelector('#connection-status');

const renderedIds = new Set();
let messageCount = 0;

function setStatus(text, state) {
  statusEl.textContent = text;
  statusEl.className = `status status--${state}`;
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

function updateEmptyState() {
  emptyStateEl.hidden = messageCount > 0;
  messageCountEl.textContent = String(messageCount);
}

function renderMessage(message) {
  if (!message || renderedIds.has(message.id)) return;

  renderedIds.add(message.id);
  messageCount += 1;

  const item = document.createElement('li');
  item.className = 'message';
  item.dataset.id = message.id;

  const body = document.createElement('p');
  body.className = 'message__text';
  body.textContent = message.text;

  const time = document.createElement('time');
  time.className = 'message__time';
  time.dateTime = message.created_at;
  time.textContent = formatTimestamp(message.created_at);

  item.append(body, time);
  messagesEl.append(item);
  updateEmptyState();
  item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function loadMessages() {
  const response = await fetch('/api/messages');
  if (!response.ok) {
    throw new Error('Unable to load messages');
  }

  const messages = await response.json();
  messages.forEach(renderMessage);
  updateEmptyState();
}

function connectStream() {
  const events = new EventSource('/api/stream');

  events.addEventListener('open', () => {
    setStatus('Live', 'online');
  });

  events.addEventListener('connected', () => {
    setStatus('Live', 'online');
  });

  events.addEventListener('message', (event) => {
    renderMessage(JSON.parse(event.data));
  });

  events.addEventListener('error', () => {
    setStatus('Reconnecting…', 'connecting');
  });
}

async function postMessage(text) {
  const response = await fetch('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Unable to post message');
  }
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  const button = formEl.querySelector('button[type="submit"]');
  button.disabled = true;

  try {
    await postMessage(text);
    inputEl.value = '';
    inputEl.focus();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});

inputEl.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    formEl.requestSubmit();
  }
});

setStatus('Connecting…', 'connecting');
loadMessages().catch((error) => {
  console.error(error);
  setStatus('History unavailable', 'offline');
});
connectStream();
