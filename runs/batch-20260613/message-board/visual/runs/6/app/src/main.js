import './styles.css';

const messagesEl = document.querySelector('#messages');
const formEl = document.querySelector('#message-form');
const inputEl = document.querySelector('#message-input');
const statusEl = document.querySelector('#connection-status');
const countEl = document.querySelector('#message-count');

const seenMessageIds = new Set();
let messageCount = 0;

function setStatus(text, mode) {
  statusEl.textContent = text;
  statusEl.className = `status status--${mode}`;
}

function updateCount() {
  countEl.textContent = `${messageCount} ${messageCount === 1 ? 'message' : 'messages'}`;
}

function formatTimestamp(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    month: 'short',
    day: 'numeric'
  }).format(new Date(value));
}

function renderEmptyState() {
  if (messageCount > 0 || messagesEl.querySelector('[data-empty]')) return;

  const item = document.createElement('li');
  item.dataset.empty = 'true';
  item.className = 'empty-state';
  item.textContent = 'No messages yet. Be the first to post!';
  messagesEl.append(item);
}

function removeEmptyState() {
  messagesEl.querySelector('[data-empty]')?.remove();
}

function appendMessage(message) {
  if (!message || seenMessageIds.has(message.id)) return;

  seenMessageIds.add(message.id);
  messageCount += 1;
  updateCount();
  removeEmptyState();

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
  item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function loadMessageHistory() {
  try {
    const response = await fetch('/api/messages');
    if (!response.ok) throw new Error(`History request failed with ${response.status}`);

    const messages = await response.json();
    messagesEl.replaceChildren();
    seenMessageIds.clear();
    messageCount = 0;

    for (const message of messages) appendMessage(message);
    renderEmptyState();
  } catch (error) {
    console.error(error);
    messagesEl.textContent = 'Could not load messages. Is the backend server running?';
  }
}

function connectToEventStream() {
  const events = new EventSource('/api/stream');

  events.onopen = () => setStatus('Live', 'live');

  events.addEventListener('message', (event) => {
    try {
      appendMessage(JSON.parse(event.data));
    } catch (error) {
      console.error('Could not parse SSE message:', error);
    }
  });

  events.onerror = () => {
    setStatus('Reconnecting…', 'connecting');
  };
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = inputEl.value.trim();
  if (!text) return;

  const submitButton = formEl.querySelector('button');
  submitButton.disabled = true;

  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Post failed with ${response.status}`);
    }

    inputEl.value = '';
    inputEl.focus();
  } catch (error) {
    console.error(error);
    alert(error.message || 'Could not post message.');
  } finally {
    submitButton.disabled = false;
  }
});

loadMessageHistory().then(connectToEventStream);
