import './styles.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

const form = document.querySelector('#message-form');
const input = document.querySelector('#message-input');
const messagesList = document.querySelector('#messages');
const emptyState = document.querySelector('#empty-state');
const statusEl = document.querySelector('#status');
const countEl = document.querySelector('#message-count');

const renderedMessageIds = new Set();
let messageCount = 0;

function endpoint(path) {
  return `${API_BASE_URL}${path}`;
}

function formatDate(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function updateCount() {
  countEl.textContent = `${messageCount} ${messageCount === 1 ? 'message' : 'messages'}`;
  emptyState.hidden = messageCount > 0;
}

function renderMessage(message) {
  if (!message || renderedMessageIds.has(message.id)) return;

  renderedMessageIds.add(message.id);
  messageCount += 1;

  const item = document.createElement('li');
  item.className = 'message-card';
  item.dataset.messageId = message.id;

  const text = document.createElement('p');
  text.className = 'message-text';
  text.textContent = message.text;

  const timestamp = document.createElement('time');
  timestamp.className = 'message-time';
  timestamp.dateTime = message.created_at;
  timestamp.textContent = formatDate(message.created_at);

  item.append(text, timestamp);
  messagesList.append(item);
  item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  updateCount();
}

function setStatus(text, tone = 'neutral') {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

async function loadMessages() {
  const response = await fetch(endpoint('/api/messages'));
  if (!response.ok) {
    throw new Error('Failed to load messages.');
  }

  const messages = await response.json();
  messages.forEach(renderMessage);
  updateCount();
}

function connectStream() {
  const stream = new EventSource(endpoint('/api/stream'));

  stream.onopen = () => {
    setStatus('Live updates connected', 'success');
  };

  stream.onmessage = (event) => {
    try {
      renderMessage(JSON.parse(event.data));
    } catch (error) {
      console.error('Could not parse SSE message', error);
    }
  };

  stream.onerror = () => {
    setStatus('Live updates reconnecting…', 'warning');
  };
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  setStatus('Posting…');

  try {
    const response = await fetch(endpoint('/api/messages'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to post message.');
    }

    // SSE will normally render the message for this tab; render here too so the
    // posting client still updates if the stream is momentarily reconnecting.
    renderMessage(payload);
    input.value = '';
    input.focus();
    setStatus('Message posted', 'success');
  } catch (error) {
    console.error(error);
    setStatus(error.message || 'Failed to post message', 'error');
  } finally {
    submitButton.disabled = false;
  }
});

loadMessages()
  .catch((error) => {
    console.error(error);
    setStatus('Could not load message history', 'error');
  })
  .finally(connectStream);
