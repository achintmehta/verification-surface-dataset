import './styles.css';

const messagesEl = document.querySelector('#messages');
const emptyStateEl = document.querySelector('#empty-state');
const formEl = document.querySelector('#message-form');
const inputEl = document.querySelector('#message-input');
const statusEl = document.querySelector('#connection-status');

const seenMessageIds = new Set();

loadMessageHistory();
connectToMessageStream();
formEl.addEventListener('submit', submitMessage);

async function loadMessageHistory() {
  try {
    const response = await fetch('/api/messages');
    if (!response.ok) {
      throw new Error(`Failed to load messages: ${response.status}`);
    }

    const messages = await response.json();
    messages.forEach(appendMessage);
    updateEmptyState();
  } catch (error) {
    console.error(error);
    showSystemMessage('Could not load message history. Is the API server running?');
  }
}

function connectToMessageStream() {
  const events = new EventSource('/api/stream');

  setStatus('connecting', 'Connecting…');

  events.addEventListener('open', () => {
    setStatus('online', 'Live');
  });

  events.addEventListener('message', (event) => {
    try {
      appendMessage(JSON.parse(event.data));
      updateEmptyState();
    } catch (error) {
      console.error('Invalid SSE payload:', error);
    }
  });

  events.addEventListener('error', () => {
    setStatus('offline', 'Reconnecting…');
  });
}

async function submitMessage(event) {
  event.preventDefault();

  const text = inputEl.value.trim();
  if (!text) return;

  const previousButtonText = formEl.querySelector('button').textContent;
  setFormDisabled(true, 'Posting…');

  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Failed to post message: ${response.status}`);
    }

    inputEl.value = '';
    inputEl.focus();
  } catch (error) {
    console.error(error);
    alert(error.message || 'Unable to post message.');
  } finally {
    setFormDisabled(false, previousButtonText);
  }
}

function appendMessage(message) {
  if (!message || seenMessageIds.has(message.id)) return;

  seenMessageIds.add(message.id);

  const item = document.createElement('li');
  item.className = 'message';

  const text = document.createElement('p');
  text.className = 'message-text';
  text.textContent = message.text;

  const time = document.createElement('time');
  time.className = 'message-time';
  time.dateTime = message.created_at;
  time.textContent = formatTimestamp(message.created_at);

  item.append(text, time);
  messagesEl.append(item);
  item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updateEmptyState() {
  emptyStateEl.hidden = seenMessageIds.size > 0;
}

function showSystemMessage(text) {
  const item = document.createElement('li');
  item.className = 'message system-message';
  item.textContent = text;
  messagesEl.append(item);
  emptyStateEl.hidden = true;
}

function setStatus(state, label) {
  statusEl.textContent = label;
  statusEl.className = `status status-${state}`;
}

function setFormDisabled(disabled, buttonText) {
  inputEl.disabled = disabled;
  const button = formEl.querySelector('button');
  button.disabled = disabled;
  button.textContent = buttonText;
}

function formatTimestamp(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}
