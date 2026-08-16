import './styles.css';

const form = document.querySelector('#message-form');
const input = document.querySelector('#message-input');
const messageList = document.querySelector('#messages');
const emptyState = document.querySelector('#empty-state');
const statusText = document.querySelector('#status');
const messageCount = document.querySelector('#message-count');
const seenMessageIds = new Set();

function formatTimestamp(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function setStatus(message, tone = 'neutral') {
  statusText.textContent = message;
  statusText.dataset.tone = tone;
}

function updateEmptyState() {
  const count = seenMessageIds.size;
  messageCount.textContent = String(count);
  emptyState.hidden = count > 0;
}

function renderMessage(message) {
  if (seenMessageIds.has(message.id)) {
    return;
  }

  seenMessageIds.add(message.id);

  const item = document.createElement('li');
  item.className = 'message-card';

  const body = document.createElement('p');
  body.className = 'message-text';
  body.textContent = message.text;

  const time = document.createElement('time');
  time.className = 'message-time';
  time.dateTime = message.created_at;
  time.textContent = formatTimestamp(message.created_at);

  item.append(body, time);
  messageList.append(item);
  updateEmptyState();
}

async function loadMessages() {
  const response = await fetch('/api/messages');

  if (!response.ok) {
    throw new Error('Unable to load messages.');
  }

  const messages = await response.json();
  messageList.replaceChildren();
  seenMessageIds.clear();
  messages.forEach(renderMessage);
  updateEmptyState();
}

function connectToStream() {
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => {
    setStatus('Live updates connected', 'success');
  });

  source.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    renderMessage(message);
  });

  source.addEventListener('error', () => {
    setStatus('Reconnecting to live updates…', 'warning');
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
  setStatus('Posting message…');

  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      throw new Error(details.error ?? 'Unable to post message.');
    }

    input.value = '';
    input.focus();
    setStatus('Message posted', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    submitButton.disabled = false;
  }
});

connectToStream();

loadMessages().catch((error) => {
  setStatus(error.message, 'error');
});
