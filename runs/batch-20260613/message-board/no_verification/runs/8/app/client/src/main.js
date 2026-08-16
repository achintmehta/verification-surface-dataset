import './styles.css';

const messagesEl = document.querySelector('#messages');
const emptyStateEl = document.querySelector('#empty-state');
const formEl = document.querySelector('#message-form');
const inputEl = document.querySelector('#message-input');
const formStatusEl = document.querySelector('#form-status');
const connectionStatusEl = document.querySelector('#connection-status');

const renderedMessageIds = new Set();

function formatTimestamp(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function updateEmptyState() {
  emptyStateEl.hidden = messagesEl.children.length > 0;
}

function setFormStatus(message, isError = false) {
  formStatusEl.textContent = message;
  formStatusEl.classList.toggle('error', isError);
}

function setConnectionStatus(message, state = 'connecting') {
  connectionStatusEl.textContent = message;
  connectionStatusEl.dataset.state = state;
}

function renderMessage(message) {
  if (!message || renderedMessageIds.has(message.id)) {
    return;
  }

  renderedMessageIds.add(message.id);

  const item = document.createElement('li');
  item.className = 'message-card';

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

async function loadMessages() {
  const response = await fetch('/api/messages');

  if (!response.ok) {
    throw new Error('Could not load messages.');
  }

  const messages = await response.json();
  messages.forEach(renderMessage);
  updateEmptyState();
}

function connectToStream() {
  const source = new EventSource('/api/stream');

  source.addEventListener('connected', () => {
    setConnectionStatus('Live', 'connected');
  });

  source.addEventListener('message', (event) => {
    try {
      renderMessage(JSON.parse(event.data));
    } catch (error) {
      console.error('Failed to parse streamed message', error);
    }
  });

  source.addEventListener('error', () => {
    setConnectionStatus('Reconnecting…', 'error');
  });
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
  setFormStatus('Posting…');

  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Could not post message.');
    }

    inputEl.value = '';
    setFormStatus('Posted.');
    inputEl.focus();
  } catch (error) {
    setFormStatus(error.message, true);
  } finally {
    submitButton.disabled = false;
  }
});

loadMessages()
  .catch((error) => {
    console.error(error);
    setFormStatus(error.message, true);
  })
  .finally(() => {
    connectToStream();
  });
