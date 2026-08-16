import './styles.css';

const messagesEl = document.querySelector('#messages');
const formEl = document.querySelector('#message-form');
const inputEl = document.querySelector('#message-input');
const statusEl = document.querySelector('#connection-status');

const renderedMessageIds = new Set();

loadMessageHistory();
connectToMessageStream();

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = inputEl.value.trim();
  if (!text) return;

  const submitButton = formEl.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Unable to post message.');
    }

    inputEl.value = '';
    inputEl.focus();
  } catch (error) {
    window.alert(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

async function loadMessageHistory() {
  try {
    const response = await fetch('/api/messages');
    if (!response.ok) throw new Error('Unable to load message history.');

    const messages = await response.json();
    messages.forEach(appendMessage);

    if (messages.length === 0) {
      showEmptyState();
    }
  } catch (error) {
    messagesEl.innerHTML = `<li class="message message--system">${escapeHtml(error.message)}</li>`;
  }
}

function connectToMessageStream() {
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => {
    setConnectionStatus('Live', 'connected');
  });

  source.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    appendMessage(message);
  });

  source.addEventListener('error', () => {
    setConnectionStatus('Reconnecting…', 'connecting');
  });
}

function appendMessage(message) {
  removeEmptyState();

  if (renderedMessageIds.has(message.id)) return;
  renderedMessageIds.add(message.id);

  const item = document.createElement('li');
  item.className = 'message';
  item.dataset.messageId = message.id;

  const text = document.createElement('p');
  text.className = 'message__text';
  text.textContent = message.text;

  const time = document.createElement('time');
  time.className = 'message__time';
  time.dateTime = message.created_at;
  time.textContent = formatTimestamp(message.created_at);

  item.append(text, time);
  messagesEl.append(item);
  item.scrollIntoView({ block: 'nearest' });
}

function showEmptyState() {
  if (messagesEl.children.length > 0) return;

  const item = document.createElement('li');
  item.className = 'message message--empty';
  item.textContent = 'No messages yet. Be the first to post!';
  messagesEl.append(item);
}

function removeEmptyState() {
  messagesEl.querySelector('.message--empty')?.remove();
}

function setConnectionStatus(text, state) {
  statusEl.textContent = text;
  statusEl.className = `status status--${state}`;
}

function formatTimestamp(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[char]));
}
