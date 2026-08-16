import './style.css';

const messagesEl = document.querySelector('#messages');
const emptyStateEl = document.querySelector('#empty-state');
const formEl = document.querySelector('#message-form');
const inputEl = document.querySelector('#message-input');
const formStatusEl = document.querySelector('#form-status');
const connectionStatusEl = document.querySelector('#connection-status');

const renderedIds = new Set();

function setConnectionStatus(text, className) {
  connectionStatusEl.textContent = text;
  connectionStatusEl.className = `status ${className}`;
}

function setFormStatus(text, isError = false) {
  formStatusEl.textContent = text;
  formStatusEl.className = isError ? 'error' : '';
}

function updateEmptyState() {
  emptyStateEl.hidden = messagesEl.children.length > 0;
}

function formatTimestamp(value) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function appendMessage(message) {
  if (!message || renderedIds.has(message.id)) {
    return;
  }

  renderedIds.add(message.id);

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
  updateEmptyState();
}

async function loadHistory() {
  const response = await fetch('/api/messages');
  if (!response.ok) {
    throw new Error('Unable to load messages.');
  }

  const messages = await response.json();
  messages.forEach(appendMessage);
  updateEmptyState();
}

function connectStream() {
  const events = new EventSource('/api/stream');

  events.addEventListener('open', () => {
    setConnectionStatus('Live', 'status-live');
  });

  events.addEventListener('message', (event) => {
    try {
      appendMessage(JSON.parse(event.data));
    } catch (error) {
      console.error('Failed to parse SSE message', error);
    }
  });

  events.addEventListener('error', () => {
    setConnectionStatus('Reconnecting...', 'status-connecting');
  });
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = inputEl.value.trim();
  if (!text) {
    return;
  }

  const submitButton = formEl.querySelector('button');
  submitButton.disabled = true;
  setFormStatus('Posting...');

  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || 'Unable to post message.');
    }

    inputEl.value = '';
    setFormStatus('Posted!');
    setTimeout(() => {
      if (formStatusEl.textContent === 'Posted!') {
        setFormStatus('');
      }
    }, 1500);
  } catch (error) {
    setFormStatus(error.message, true);
  } finally {
    submitButton.disabled = false;
    inputEl.focus();
  }
});

loadHistory()
  .catch((error) => {
    console.error(error);
    setFormStatus(error.message, true);
  })
  .finally(connectStream);
