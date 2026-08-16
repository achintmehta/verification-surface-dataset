import './styles.css';

const form = document.querySelector('#message-form');
const input = document.querySelector('#message-input');
const messageList = document.querySelector('#message-list');
const emptyState = document.querySelector('#empty-state');
const status = document.querySelector('#status');
const submitButton = form.querySelector('button[type="submit"]');

const seenMessageIds = new Set();

function setStatus(text, state = 'neutral') {
  status.textContent = text;
  status.dataset.state = state;
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
  if (!message || seenMessageIds.has(message.id)) {
    return;
  }

  seenMessageIds.add(message.id);

  const item = document.createElement('li');
  item.className = 'message-card';
  item.dataset.messageId = message.id;

  const text = document.createElement('p');
  text.className = 'message-text';
  text.textContent = message.text;

  const meta = document.createElement('time');
  meta.className = 'message-time';
  meta.dateTime = message.created_at;
  meta.textContent = formatTimestamp(message.created_at);

  item.append(text, meta);

  const messageTime = new Date(message.created_at).getTime();
  const nextItem = Array.from(messageList.children).find((child) => {
    const childTime = new Date(child.dataset.createdAt).getTime();
    return childTime > messageTime || (childTime === messageTime && Number(child.dataset.messageId) > Number(message.id));
  });

  item.dataset.createdAt = message.created_at;
  messageList.insertBefore(item, nextItem ?? null);

  emptyState.hidden = seenMessageIds.size > 0;
  item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function loadMessageHistory() {
  try {
    const response = await fetch('/api/messages');

    if (!response.ok) {
      throw new Error(`History request failed with ${response.status}`);
    }

    const messages = await response.json();
    messages.forEach(renderMessage);
    emptyState.hidden = seenMessageIds.size > 0;
  } catch (error) {
    console.error(error);
    setStatus('Could not load message history', 'error');
  }
}

function connectStream() {
  const events = new EventSource('/api/stream');

  events.addEventListener('ready', () => {
    setStatus('Live updates connected', 'connected');
  });

  events.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      renderMessage(message);
      setStatus('Live updates connected', 'connected');
    } catch (error) {
      console.error('Could not parse SSE message', error);
    }
  });

  events.onerror = () => {
    // EventSource automatically reconnects; this status lets users know what is happening.
    setStatus('Reconnecting live updates...', 'warning');
  };
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }

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
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Post failed with ${response.status}`);
    }

    // The SSE broadcast will add the message to the feed for every client,
    // including this one. Clear the input as soon as the server accepts it.
    input.value = '';
    input.focus();
  } catch (error) {
    console.error(error);
    setStatus(error.message || 'Could not post message', 'error');
  } finally {
    submitButton.disabled = false;
  }
});

await loadMessageHistory();
connectStream();
