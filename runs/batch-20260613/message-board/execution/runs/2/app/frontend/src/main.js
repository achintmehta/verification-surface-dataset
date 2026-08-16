/**
 * main.js – application entry point.
 *
 * Responsibilities:
 *  1. Fetch message history on load and render it.
 *  2. Open an SSE connection and append incoming messages in real-time.
 *  3. Handle the compose form: POST the message, clear the input.
 */

import { fetchMessages, postMessage, openStream } from './api.js';
import {
  renderMessages,
  appendMessage,
  setStatus,
  showError,
  setSubmitting,
} from './ui.js';

/* ── 1. Load historical messages ──────────────────────────────────── */
async function loadHistory() {
  try {
    const messages = await fetchMessages();
    renderMessages(messages);
  } catch (err) {
    console.error('[main] failed to load message history:', err);
    showError('Could not load messages. Please refresh the page.');
  }
}

/* ── 2. Open SSE stream ───────────────────────────────────────────── */
function connectStream() {
  setStatus('connecting');

  openStream({
    onOpen() {
      setStatus('connected');
    },

    onMessage(message) {
      appendMessage(message);
    },

    onError(err) {
      console.warn('[main] SSE error – browser will auto-reconnect:', err);
      setStatus('error');
    },
  });
}

/* ── 3. Compose form ──────────────────────────────────────────────── */
const form  = /** @type {HTMLFormElement}  */ (document.getElementById('compose-form'));
const input = /** @type {HTMLInputElement} */ (document.getElementById('message-input'));

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  showError(null);
  setSubmitting(true);

  try {
    await postMessage(text);
    // Clear the input on success; the SSE broadcast will add the message to
    // the feed so we don't need to append it manually here.
    input.value = '';
  } catch (err) {
    console.error('[main] failed to post message:', err);
    showError(err.message ?? 'Failed to send message. Please try again.');
  } finally {
    setSubmitting(false);
    input.focus();
  }
});

/* ── Bootstrap ────────────────────────────────────────────────────── */
loadHistory();
connectStream();
