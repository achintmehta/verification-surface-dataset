import './styles.css';

const messagesEl = document.querySelector('#messages');
const emptyStateEl = document.querySelector('#empty-state');
const countEl = document.querySelector('#message-count');
const formEl = document.querySelector('#message-form');
const inputEl = document.querySelector('#message-input');
const statusEl = document.querySelector('#connection-status');

const renderedMessageIds = new Set();
let messageCount = 0;

function setStatus(text, state) {
  statusEl.textContent = text;
  statusEl.className = `status status--${state}`;
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function updateEmptyState() {
  emptyStateEl.hidden = messageCount > 0;
  countEl.textContent = String(messageCount);
}

function renderMessage(message) {
  if (!message || renderedMessageIds.has(message.id)) return;

  renderedMessageIds.add(message.id);
  messageCount += 1;

  const itemEl = document.createElement('li');
  itemEl.className = 'message-item';
  itemEl.dataset.id = message.id;

  const textEl = document.createElement('p');
  textEl.className = 'message-text';
  textEl.textContent = message.text;

  const timeEl = document.createElement('time');
  timeEl.className = 'message-time';
  timeEl.dateTime = message.created_at;
  timeEl.textContent = formatTimestamp(message.created_at);

  itemEl.append(textEl, timeEl);
  messagesEl.append(itemEl);
  itemEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  updateEmptyState();
}

async function loadMessageHistory() {
  const response = await fetch('/api/messages');
  if (!response.ok) {
    throw new Error(`Failed to load messages: ${response.status}`);
  }

  const messages = await response.json();
  messages.forEach(renderMessage);
  updateEmptyState();
}

function connectToMessageStream() {
  const events = new EventSource('/api/stream');

  events.addEventListener('open', () => {
    setStatus('Live', 'connected');
  });

  events.addEventListener('connected', () => {
    setStatus('Live', 'connected');
  });

  events.addEventListener('message', (event) => {
    try {
      renderMessage(JSON.parse(event.data));
    } catch (error) {
      console.error('Could not parse SSE message', error);
    }
  });

  events.addEventListener('error', () => {
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
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.error || `Failed to post message: ${response.status}`);
    }

    inputEl.value = '';
    inputEl.focus();
  } catch (error) {
    console.error(error);
    alert(error.message || 'Could not post message. Please try again.');
  } finally {
    submitButton.disabled = false;
  }
});

loadMessageHistory().catch((error) => {
  console.error(error);
  setStatus('History failed to load', 'error');
});
connectToMessageStream();
updateEmptyState();
