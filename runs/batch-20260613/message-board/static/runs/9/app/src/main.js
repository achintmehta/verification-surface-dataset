import './styles.css';

const configuredApiUrl = import.meta.env.VITE_API_URL;
const apiBaseUrl = configuredApiUrl ? configuredApiUrl.replace(/\/$/, '') : 'http://localhost:3000';

const messagesList = document.querySelector('#messages');
const emptyState = document.querySelector('#empty-state');
const form = document.querySelector('#message-form');
const input = document.querySelector('#message-input');
const status = document.querySelector('#status');

const renderedMessageIds = new Set();

function setStatus(message, state = 'neutral') {
  status.textContent = message;
  status.dataset.state = state;
}

function updateEmptyState() {
  emptyState.hidden = messagesList.children.length > 0;
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function renderMessage(message) {
  if (!message || renderedMessageIds.has(message.id)) {
    return;
  }

  renderedMessageIds.add(message.id);

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
  messagesList.append(item);
  updateEmptyState();
}

async function loadMessages() {
  const response = await fetch(`${apiBaseUrl}/api/messages`);

  if (!response.ok) {
    throw new Error(`Failed to load messages (${response.status})`);
  }

  const messages = await response.json();
  messages.forEach(renderMessage);
  updateEmptyState();
}

function connectStream() {
  const stream = new EventSource(`${apiBaseUrl}/api/stream`);

  stream.addEventListener('open', () => {
    setStatus('Live updates connected', 'ok');
  });

  stream.addEventListener('message', (event) => {
    try {
      renderMessage(JSON.parse(event.data));
    } catch (error) {
      console.error('Unable to parse streamed message', error);
    }
  });

  stream.addEventListener('error', () => {
    setStatus('Live updates disconnected. Reconnecting…', 'warn');
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  try {
    const response = await fetch(`${apiBaseUrl}/api/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Failed to post message (${response.status})`);
    }

    input.value = '';
    input.focus();
  } catch (error) {
    console.error(error);
    setStatus(error.message, 'error');
  } finally {
    submitButton.disabled = false;
  }
});

loadMessages()
  .then(() => {
    connectStream();
  })
  .catch((error) => {
    console.error(error);
    setStatus('Unable to load messages. Is the server running?', 'error');
    updateEmptyState();
  });
