import './styles.css';

const messagesEl = document.querySelector('#messages');
const emptyStateEl = document.querySelector('#empty-state');
const formEl = document.querySelector('#message-form');
const inputEl = document.querySelector('#message-input');
const feedbackEl = document.querySelector('#form-feedback');
const statusEl = document.querySelector('#connection-status');

const renderedMessageIds = new Set();

function setConnectionStatus(text, state) {
  statusEl.textContent = text;
  statusEl.className = `status status--${state}`;
}

function setFeedback(text, isError = false) {
  feedbackEl.textContent = text;
  feedbackEl.classList.toggle('is-error', isError);
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
  item.dataset.id = message.id;

  const text = document.createElement('p');
  text.className = 'message__text';
  text.textContent = message.text;

  const meta = document.createElement('time');
  meta.className = 'message__time';
  meta.dateTime = message.created_at;
  meta.textContent = formatTimestamp(message.created_at);

  item.append(text, meta);
  messagesEl.append(item);
  emptyStateEl.hidden = renderedMessageIds.size > 0;
  item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function loadMessageHistory() {
  const response = await fetch('/api/messages');

  if (!response.ok) {
    throw new Error('Could not load messages.');
  }

  const messages = await response.json();
  messages.forEach(renderMessage);
  emptyStateEl.hidden = renderedMessageIds.size > 0;
}

function connectToStream() {
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => {
    setConnectionStatus('Live', 'live');
  });

  source.addEventListener('connected', () => {
    setConnectionStatus('Live', 'live');
  });

  source.addEventListener('message', (event) => {
    try {
      renderMessage(JSON.parse(event.data));
    } catch (error) {
      console.error('Failed to parse streamed message', error);
    }
  });

  source.addEventListener('error', () => {
    setConnectionStatus('Reconnecting…', 'connecting');
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
  setFeedback('Posting…');

  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || 'Could not post message.');
    }

    // The SSE broadcast will append the message. This fallback keeps the UI
    // responsive if a browser/proxy delays the stream briefly.
    renderMessage(payload);
    inputEl.value = '';
    inputEl.focus();
    setFeedback('Posted.');
    window.setTimeout(() => setFeedback(''), 1500);
  } catch (error) {
    setFeedback(error.message, true);
  } finally {
    submitButton.disabled = false;
  }
});

async function start() {
  try {
    await loadMessageHistory();
  } catch (error) {
    setFeedback(error.message, true);
  } finally {
    connectToStream();
  }
}

start();
