import './style.css';

const messageList = document.querySelector('#message-list');
const emptyState = document.querySelector('#empty-state');
const form = document.querySelector('#message-form');
const input = document.querySelector('#message-input');
const status = document.querySelector('#status');
const submitButton = form.querySelector('button[type="submit"]');

const renderedMessageIds = new Set();

function setStatus(text, tone = 'neutral') {
  status.textContent = text;
  status.dataset.tone = tone;
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

function updateEmptyState() {
  emptyState.hidden = messageList.children.length > 0;
}

function renderMessage(message) {
  if (!message || renderedMessageIds.has(message.id)) {
    return;
  }

  renderedMessageIds.add(message.id);

  const item = document.createElement('li');
  item.className = 'message-card';
  item.dataset.id = message.id;

  const text = document.createElement('p');
  text.className = 'message-text';
  text.textContent = message.text;

  const time = document.createElement('time');
  time.dateTime = message.created_at;
  time.textContent = formatTimestamp(message.created_at);

  item.append(text, time);
  messageList.append(item);
  updateEmptyState();
}

async function loadMessages() {
  const response = await fetch('/api/messages');

  if (!response.ok) {
    throw new Error('Could not load message history.');
  }

  const messages = await response.json();
  messages.forEach(renderMessage);
  updateEmptyState();
}

function connectStream() {
  const events = new EventSource('/api/stream');

  events.addEventListener('ready', () => {
    setStatus('Connected. New messages will appear live.', 'success');
  });

  events.addEventListener('message', (event) => {
    renderMessage(JSON.parse(event.data));
  });

  events.addEventListener('error', () => {
    setStatus('Realtime connection lost. Reconnecting…', 'warning');
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }

  submitButton.disabled = true;
  setStatus('Posting message…');

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
      throw new Error(body.error || 'Could not post message.');
    }

    input.value = '';
    input.focus();
    setStatus('Message posted.', 'success');
  } catch (error) {
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
    updateEmptyState();
    setStatus(error.message, 'error');
    connectStream();
  });
