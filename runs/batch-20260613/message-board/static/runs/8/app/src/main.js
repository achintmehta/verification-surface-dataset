import './styles.css';

const messagesEl = document.querySelector('#messages');
const emptyStateEl = document.querySelector('#empty-state');
const formEl = document.querySelector('#message-form');
const inputEl = document.querySelector('#message-input');
const statusEl = document.querySelector('#connection-status');

const seenMessageIds = new Set();

function setStatus(label, modifier) {
  statusEl.textContent = label;
  statusEl.className = `status status--${modifier}`;
}

function updateEmptyState() {
  emptyStateEl.classList.toggle('is-visible', seenMessageIds.size === 0);
}

function formatMessageTime(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function renderMessage(message) {
  if (!message || seenMessageIds.has(message.id)) {
    return;
  }

  seenMessageIds.add(message.id);

  const item = document.createElement('li');
  item.className = 'message';

  const text = document.createElement('p');
  text.className = 'message__text';
  text.textContent = message.text;

  const timestamp = document.createElement('time');
  timestamp.className = 'message__time';
  timestamp.dateTime = message.created_at;
  timestamp.textContent = formatMessageTime(message.created_at);

  item.append(text, timestamp);
  messagesEl.append(item);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  updateEmptyState();
}

async function loadMessageHistory() {
  const response = await fetch('/api/messages');

  if (!response.ok) {
    throw new Error(`Unable to fetch messages (${response.status})`);
  }

  const messages = await response.json();
  messages.forEach(renderMessage);
  updateEmptyState();
}

function connectStream() {
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => {
    setStatus('Online', 'online');
  });

  source.addEventListener('message', (event) => {
    try {
      renderMessage(JSON.parse(event.data));
    } catch (error) {
      console.error('Failed to parse realtime message', error);
    }
  });

  source.addEventListener('error', () => {
    setStatus('Reconnecting', 'offline');
  });
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = inputEl.value.trim();
  if (!text) {
    inputEl.value = '';
    return;
  }

  const submitButton = formEl.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.error || `Unable to post message (${response.status})`);
    }

    inputEl.value = '';
    inputEl.focus();
  } catch (error) {
    console.error(error);
    alert(error.message || 'Unable to post message. Please try again.');
  } finally {
    submitButton.disabled = false;
  }
});

loadMessageHistory().catch((error) => {
  console.error(error);
  alert('Could not load message history. Is the backend server running?');
});

connectStream();
updateEmptyState();
