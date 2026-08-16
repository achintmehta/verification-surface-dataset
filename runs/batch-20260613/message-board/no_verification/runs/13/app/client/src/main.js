// Realtime Message Board — frontend logic.
//
// Responsibilities:
//   1. Load the message history on page load (GET /api/messages).
//   2. Subscribe to live updates via SSE (GET /api/stream) using EventSource.
//   3. Append new messages to the DOM as they arrive.
//   4. Send new messages via POST /api/messages.

const messagesEl = document.getElementById("messages");
const emptyEl = document.getElementById("empty");
const formEl = document.getElementById("form");
const inputEl = document.getElementById("input");
const buttonEl = formEl.querySelector("button");
const statusEl = document.getElementById("status");

// Track seen message ids to avoid rendering duplicates (e.g. if the POST
// response and an SSE broadcast both arrive).
const seenIds = new Set();

function setStatus(state, label) {
  statusEl.className = `status status--${state}`;
  statusEl.textContent = label;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function hideEmptyState() {
  if (emptyEl && emptyEl.parentNode) {
    emptyEl.remove();
  }
}

/**
 * Render a single message into the list (appended at the bottom).
 * No-op if the message has already been rendered.
 */
function renderMessage(message) {
  if (message == null || message.id == null) return;
  if (seenIds.has(message.id)) return;
  seenIds.add(message.id);

  hideEmptyState();

  const li = document.createElement("li");
  li.className = "message";
  li.dataset.id = String(message.id);

  const text = document.createElement("p");
  text.className = "message__text";
  text.textContent = message.text;

  const time = document.createElement("time");
  time.className = "message__time";
  time.textContent = formatTime(message.created_at);

  li.append(text, time);
  messagesEl.appendChild(li);

  // Keep the newest message in view.
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** Fetch and render the initial message history. */
async function loadHistory() {
  try {
    const res = await fetch("/api/messages");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach(renderMessage);
  } catch (err) {
    console.error("Failed to load history:", err);
  }
}

/** Open the SSE connection and wire up event handlers. */
function connectStream() {
  const source = new EventSource("/api/stream");

  source.addEventListener("open", () => setStatus("online", "● live"));

  source.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      renderMessage(message);
    } catch (err) {
      console.error("Failed to parse SSE message:", err);
    }
  });

  source.addEventListener("error", () => {
    // EventSource automatically attempts to reconnect.
    setStatus("offline", "○ reconnecting…");
  });
}

/** Handle form submission: POST the message, then clear the input. */
formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  buttonEl.disabled = true;
  try {
    const res = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Render immediately for snappy UX; the SSE broadcast is de-duplicated.
    const message = await res.json();
    renderMessage(message);

    inputEl.value = "";
  } catch (err) {
    console.error("Failed to send message:", err);
  } finally {
    buttonEl.disabled = false;
    inputEl.focus();
  }
});

// Boot the app.
setStatus("connecting", "connecting…");
loadHistory();
connectStream();
