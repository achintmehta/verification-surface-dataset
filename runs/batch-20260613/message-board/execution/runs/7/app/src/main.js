import './style.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

const form = document.querySelector('#message-form');
const input = document.querySelector('#message-input');
const messagesList = document.querySelector('#messages');
const emptyState = document.querySelector('#empty-state');
const status = document.querySelector('#status');

const renderedMessageIds = new Set();

function setStatus(text, state) {
  status.textContent = text;
  status.className = `status status--${state}`;
}

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

function renderMessage(message) {
  if (!message || renderedMessageIds.has(message.id)) {
    return;
  }

  renderedMessageIds.add(message.id);

  const item = document.createElement('li');
  item.className = 'message';
  item.dataset.messageId = message.id;

  const text = document.createElement('p');
  text.className = 'message__text';
  text.textContent = message.text;

  const meta = document.createElement('time');
  meta.className = 'message__time';
  meta.dateTime = message.created_at;
  meta.textContent = formatTimestamp(message.created_at);

  item.append(text, meta);
  messagesList.append(item);
  emptyState.hidden = renderedMessageIds.size > 0;
  item.scrollIntoView({ block: 'nearest' });
}

async function loadMessages() {
  const response = await fetch(`${API_BASE_URL}/api/messages`);

  if (!response.ok) {
    throw new Error('Unable to load message history.');
  }

  const messages = await response.json();
  messages.forEach(renderMessage);
  emptyState.hidden = renderedMessageIds.size > 0;
}

function connectToStream() {
  const events = new EventSource(`${API_BASE_URL}/api/stream`);

  events.addEventListener('connected', () => {
    setStatus('Live updates connected', 'connected');
  });

  events.addEventListener('message', (event) => {
    renderMessage(JSON.parse(event.data));
  });

  events.onerror = () => {
    setStatus('Reconnecting…', 'connecting');
  };
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  try {
    const response = await fetch(`${API_BASE_URL}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Unable to post message.');
    }

    input.value = '';
    input.focus();
  } catch (error) {
    alert(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

async function start() {
  try {
    await loadMessages();
    connectToStream();
  } catch (error) {
    console.error(error);
    setStatus('Could not connect to server', 'error');
  }
}

start();
