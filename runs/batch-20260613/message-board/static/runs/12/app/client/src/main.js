const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("message-form");
const inputEl = document.getElementById("message-input");
const statusEl = document.getElementById("status");

// Track rendered message ids so the SSE stream never duplicates a message
// that was already shown (e.g. the optimistic POST response).
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

function renderEmptyState() {
  if (messagesEl.querySelector(".messages__empty")) return;
  const li = document.createElement("li");
  li.className = "messages__empty";
  li.textContent = "No messages yet. Be the first to post!";
  messagesEl.appendChild(li);
}

function clearEmptyState() {
  const empty = messagesEl.querySelector(".messages__empty");
  if (empty) empty.remove();
}

/**
 * Append a single message to the DOM. Ignores duplicates.
 * @param {{ id: number, text: string, created_at: string }} message
 */
function appendMessage(message) {
  if (seenIds.has(message.id)) return;
  seenIds.add(message.id);
  clearEmptyState();

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
  messagesEl.appendChild(li);

  // Keep the newest message in view.
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/**
 * Load the historical messages and render them.
 */
async function loadHistory() {
  try {
    const res = await fetch("/api/messages");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();

    if (!messages.length) {
      renderEmptyState();
      return;
    }
    for (const message of messages) {
      appendMessage(message);
    }
  } catch (err) {
    console.error("Failed to load history:", err);
    renderEmptyState();
  }
}

/**
 * Open the SSE connection and listen for live message events.
 */
function connectStream() {
  setStatus("connecting", "connecting…");
  const source = new EventSource("/api/stream");

  source.addEventListener("open", () => {
    setStatus("online", "live");
  });

  source.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      appendMessage(message);
    } catch (err) {
      console.error("Failed to parse SSE message:", err);
    }
  });

  source.addEventListener("error", () => {
    // EventSource reconnects automatically; reflect the transient state.
    setStatus("offline", "reconnecting…");
  });
}

/**
 * Handle form submission: POST the message and clear the input.
 */
formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  const button = formEl.querySelector("button");
  button.disabled = true;
  inputEl.disabled = true;

  try {
    const res = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Render immediately for snappy UX; the SSE echo is de-duplicated.
    const message = await res.json();
    appendMessage(message);

    inputEl.value = "";
  } catch (err) {
    console.error("Failed to send message:", err);
  } finally {
    button.disabled = false;
    inputEl.disabled = false;
    inputEl.focus();
  }
});

loadHistory();
connectStream();
