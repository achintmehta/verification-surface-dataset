import './styles.css';

const messageList = document.querySelector('#messageList');
const messageForm = document.querySelector('#messageForm');
const messageInput = document.querySelector('#messageInput');
const emptyState = document.querySelector('#emptyState');
const connectionStatus = document.querySelector('#connectionStatus');

const renderedMessageIds = new Set();

function setStatus(label, state) {
  connectionStatus.textContent = label;
  connectionStatus.className = `status status--${state}`;
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric'
  }).format(date);
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
  messageList.append(item);
  item.scrollIntoView({ block: 'end', behavior: 'smooth' });
  updateEmptyState();
}

async function loadMessageHistory() {
  const response = await fetch('/api/messages');
  if (!response.ok) {
    throw new Error('Unable to load message history.');
  }

  const data = await response.json();
  for (const message of data.messages ?? []) {
    renderMessage(message);
  }
  updateEmptyState();
}

function connectToStream() {
  const events = new EventSource('/api/stream');

  events.addEventListener('open', () => {
    setStatus('Live', 'live');
  });

  events.addEventListener('ready', () => {
    setStatus('Live', 'live');
  });

  events.addEventListener('message', (event) => {
    try {
      renderMessage(JSON.parse(event.data));
    } catch (error) {
      console.error('Could not parse SSE message', error);
    }
  });

  events.addEventListener('error', () => {
    setStatus('Reconnecting', 'connecting');
  });
}

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = messageInput.value.trim();
  if (!text) return;

  const submitButton = messageForm.querySelector('button');
  submitButton.disabled = true;

  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Could not post message.');
    }

    messageInput.value = '';
    messageInput.focus();
  } catch (error) {
    alert(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

loadMessageHistory().catch((error) => {
  console.error(error);
  setStatus('History unavailable', 'error');
});
connectToStream();
updateEmptyState();
