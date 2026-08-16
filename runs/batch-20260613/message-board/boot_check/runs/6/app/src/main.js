import './styles.css';

const form = document.querySelector('#message-form');
const input = document.querySelector('#message-input');
const list = document.querySelector('#message-list');
const emptyState = document.querySelector('#empty-state');
const status = document.querySelector('#status');

const renderedIds = new Set();

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

function updateEmptyState() {
  emptyState.hidden = renderedIds.size > 0;
}

function renderMessage(message) {
  if (!message || renderedIds.has(message.id)) {
    return;
  }

  renderedIds.add(message.id);

  const item = document.createElement('li');
  item.className = 'message';
  item.dataset.id = message.id;

  const text = document.createElement('p');
  text.className = 'message-text';
  text.textContent = message.text;

  const meta = document.createElement('time');
  meta.className = 'message-time';
  meta.dateTime = message.created_at;
  meta.textContent = formatTimestamp(message.created_at);

  item.append(text, meta);
  list.append(item);
  updateEmptyState();
}

async function loadMessages() {
  const response = await fetch('/api/messages');

  if (!response.ok) {
    throw new Error('Unable to fetch messages');
  }

  const messages = await response.json();
  messages.forEach(renderMessage);
  updateEmptyState();
}

function connectStream() {
  const events = new EventSource('/api/stream');

  events.addEventListener('connected', () => {
    status.textContent = 'Live updates connected';
    status.className = 'online';
  });

  events.addEventListener('message', (event) => {
    try {
      renderMessage(JSON.parse(event.data));
    } catch (error) {
      console.error('Failed to parse SSE message', error);
    }
  });

  events.onerror = () => {
    status.textContent = 'Live connection interrupted. Reconnecting...';
    status.className = 'offline';
  };
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = input.value.trim();
  if (!text) {
    return;
  }

  const submitButton = form.querySelector('button');
  submitButton.disabled = true;

  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to post message');
    }

    input.value = '';
    input.focus();
  } catch (error) {
    console.error(error);
    status.textContent = error.message;
    status.className = 'offline';
  } finally {
    submitButton.disabled = false;
  }
});

loadMessages()
  .then(connectStream)
  .catch((error) => {
    console.error(error);
    status.textContent = 'Could not load messages. Is the API server running?';
    status.className = 'offline';
    updateEmptyState();
    connectStream();
  });
