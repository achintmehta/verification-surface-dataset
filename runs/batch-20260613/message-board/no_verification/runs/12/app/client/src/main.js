import "./style.css";

const API_BASE = "/api";

// --- DOM references --------------------------------------------------------
const messagesEl = document.getElementById("messages");
const emptyStateEl = document.getElementById("empty-state");
const formEl = document.getElementById("message-form");
const inputEl = document.getElementById("message-input");
const sendButtonEl = document.getElementById("send-button");
const statusEl = document.getElementById("status");

// Track which message ids are already rendered so we never show duplicates
// (e.g. the POST response + the SSE broadcast of the same message).
const renderedIds = new Set();

// --- Rendering helpers -----------------------------------------------------
function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}

function setStatus(state, label) {
  statusEl.className = `status status--${state}`;
  statusEl.textContent = label;
}

function hideEmptyState() {
  if (emptyStateEl && emptyStateEl.parentNode) {
    emptyStateEl.remove();
  }
}

function renderMessage(message, { prepend = false } = {}) {
  if (renderedIds.has(message.id)) return;
  renderedIds.add(message.id);
  hideEmptyState();

  const li = document.createElement("li");
  li.className = "message";
  li.dataset.id = String(message.id);

  const text = document.createElement("p");
  text.className = "message__text";
  text.textContent = message.text;

  const time = document.createElement("time");
  time.className = "message__time";
  time.dateTime = message.created_at;
  time.textContent = formatTime(message.created_at);

  li.append(text, time);

  if (prepend) {
    messagesEl.prepend(li);
  } else {
    messagesEl.append(li);
  }

  scrollToBottom();
}

function scrollToBottom() {
  const main = document.querySelector(".board-main");
  if (main) main.scrollTop = main.scrollHeight;
}

// --- Initial history -------------------------------------------------------
async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    for (const message of messages) {
      renderMessage(message);
    }
  } catch (err) {
    console.error("Failed to load message history:", err);
  }
}

// --- Realtime stream (SSE) -------------------------------------------------
function connectStream() {
  const source = new EventSource(`${API_BASE}/stream`);

  source.addEventListener("connected", () => {
    setStatus("online", "live");
  });

  source.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      renderMessage(message);
    } catch (err) {
      console.error("Failed to parse incoming message:", err);
    }
  });

  source.onopen = () => setStatus("online", "live");

  source.onerror = () => {
    // EventSource auto-reconnects; reflect the transient state in the UI.
    setStatus("offline", "reconnecting…");
  };
}

// --- Posting messages ------------------------------------------------------
async function sendMessage(text) {
  const res = await fetch(`${API_BASE}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  sendButtonEl.disabled = true;
  try {
    const message = await sendMessage(text);
    // Render immediately for snappy feedback; the SSE broadcast will be
    // de-duplicated via renderedIds.
    renderMessage(message);
    inputEl.value = "";
  } catch (err) {
    console.error("Failed to send message:", err);
    alert(`Could not send message: ${err.message}`);
  } finally {
    sendButtonEl.disabled = false;
    inputEl.focus();
  }
});

// --- Boot ------------------------------------------------------------------
setStatus("connecting", "connecting…");
loadHistory().finally(connectStream);
