import './style.css';
import { fetchMessages, postMessage, connectStream } from './api.js';

/** @typedef {import('./api.js').Message} Message */

// --- DOM references -------------------------------------------------------
const messagesEl = document.getElementById('messages');
const emptyEl = document.getElementById('empty');
const statusEl = document.getElementById('status');
const formEl = document.getElementById('composer');
const inputEl = document.getElementById('text');
const sendBtn = document.getElementById('send');

// Track which message ids we've already rendered so SSE echoes of our own
// posts (or duplicates) don't appear twice.
const seenIds = new Set();

// --- Rendering ------------------------------------------------------------

/** Format an ISO timestamp into a friendly local time string. */
function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function updateEmptyState() {
  emptyEl.hidden = messagesEl.children.length > 0;
}

/**
 * Append a single message to the DOM (if not already present).
 * @param {Message} message
 * @param {boolean} [scroll=true]
 */
function appendMessage(message, scroll = true) {
  if (seenIds.has(message.id)) return;
  seenIds.add(message.id);

  const li = document.createElement('li');
  li.className = 'message';
  li.dataset.id = String(message.id);

  const textEl = document.createElement('span');
  textEl.className = 'message__text';
  textEl.textContent = message.text;

  const metaEl = document.createElement('time');
  metaEl.className = 'message__meta';
  metaEl.dateTime = message.created_at;
  metaEl.textContent = formatTime(message.created_at);

  li.append(textEl, metaEl);
  messagesEl.append(li);

  updateEmptyState();

  if (scroll) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// --- Connection status ----------------------------------------------------

/** @param {'connecting'|'online'|'offline'} state */
function setStatus(state) {
  const labels = {
    connecting: 'Connecting…',
    online: 'Live',
    offline: 'Reconnecting…',
  };
  statusEl.textContent = labels[state];
  statusEl.className = `status status--${state === 'online' ? 'online' : state === 'offline' ? 'offline' : 'connecting'}`;
}

// --- Bootstrapping --------------------------------------------------------

async function loadHistory() {
  try {
    const history = await fetchMessages();
    for (const message of history) {
      appendMessage(message, false);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    updateEmptyState();
  } catch (err) {
    console.error(err);
  }
}

function startStream() {
  connectStream({
    onOpen: () => setStatus('online'),
    onError: () => setStatus('offline'),
    onMessage: (message) => appendMessage(message),
  });
}

// --- Form handling --------------------------------------------------------

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  // Optimistically disable the controls while the request is in-flight.
  inputEl.disabled = true;
  sendBtn.disabled = true;

  try {
    const message = await postMessage(text);
    // Render immediately; the SSE echo will be de-duplicated by id.
    appendMessage(message);
    inputEl.value = '';
  } catch (err) {
    console.error(err);
    alert(err.message);
  } finally {
    inputEl.disabled = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
});

// --- Init -----------------------------------------------------------------

setStatus('connecting');
loadHistory().then(startStream);
