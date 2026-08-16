/**
 * main.js
 * Application entry point.
 *
 * Orchestrates:
 *  1. Fetching the initial message history on page load.
 *  2. Opening an SSE connection and appending incoming messages in real-time.
 *  3. Handling form submission to POST new messages.
 */

import { fetchMessages, postMessage, openStream } from './api.js';
import {
  renderMessages,
  appendMessage,
  setStatus,
  lockForm,
  unlockForm,
  composeForm,
  messageInput,
} from './ui.js';

/* ── 1. Load initial message history ────────────────────────────────────── */

async function loadHistory() {
  try {
    const messages = await fetchMessages();
    renderMessages(messages);
  } catch (err) {
    console.error('[history] Failed to load messages:', err);
    // Non-fatal – the SSE stream will still deliver new messages.
  }
}

/* ── 2. SSE real-time connection ────────────────────────────────────────── */

/**
 * Opens the SSE stream and wires up event handlers.
 * Automatically attempts to reconnect on error (the browser's native
 * EventSource reconnection logic handles this, but we update the badge).
 */
function connectStream() {
  setStatus('connecting');

  const source = openStream();

  source.addEventListener('open', () => {
    setStatus('connected');
  });

  /**
   * The server broadcasts `new-message` events whenever a message is inserted.
   * Each event's `data` field contains the full message object as JSON.
   */
  source.addEventListener('new-message', (event) => {
    try {
      const message = JSON.parse(event.data);
      appendMessage(message);
    } catch (err) {
      console.error('[sse] Failed to parse new-message event:', err);
    }
  });

  source.addEventListener('error', () => {
    // The browser will automatically try to reconnect; we just update the UI.
    setStatus('error');
  });

  return source;
}

/* ── 3. Form submission ─────────────────────────────────────────────────── */

/**
 * Handles the compose form's submit event.
 * Sends the message text to the backend via POST and clears the input on
 * success.  The SSE broadcast from the server will add the message to the
 * feed for all connected clients (including this one), so we do NOT manually
 * append the message here to avoid duplicates.
 *
 * @param {SubmitEvent} event
 */
async function handleSubmit(event) {
  event.preventDefault();

  const text = messageInput.value.trim();
  if (!text) return;

  lockForm();

  try {
    await postMessage(text);
    // Clear the input on success.  The SSE event will render the new message.
    messageInput.value = '';
  } catch (err) {
    console.error('[submit] Failed to post message:', err);
    alert(`Could not send message: ${err.message}`);
  } finally {
    unlockForm();
  }
}

/* ── Bootstrap ──────────────────────────────────────────────────────────── */

(async function init() {
  // Load history and open the SSE stream concurrently so neither blocks the
  // other.  History is rendered first; any SSE messages that arrive before
  // history is painted will be deduplicated by appendMessage's id-guard.
  await Promise.all([
    loadHistory(),
    Promise.resolve(connectStream()),
  ]);

  composeForm.addEventListener('submit', handleSubmit);
})();
