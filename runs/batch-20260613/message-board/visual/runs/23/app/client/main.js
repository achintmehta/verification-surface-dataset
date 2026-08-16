// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const API_BASE = "http://localhost:3001";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const messagesList = document.getElementById("messages");
const form = document.getElementById("message-form");
const input = document.getElementById("message-input");
const statusBadge = document.getElementById("connection-status");

// Keep track of rendered message IDs to avoid duplicates
const renderedIds = new Set();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a timestamp into a human-readable string.
 * @param {string} iso
 * @returns {string}
 */
function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Safely escape HTML to prevent XSS when inserting user text.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Create a message <li> element.
 * @param {{ id: number, text: string, created_at: string }} msg
 * @returns {HTMLLIElement}
 */
function createMessageElement(msg) {
  const li = document.createElement("li");
  li.className = "message-item";
  li.dataset.id = msg.id;
  li.innerHTML = `
    <span class="message-text">${escapeHtml(msg.text)}</span>
    <time class="message-time" datetime="${msg.created_at}">${formatTime(msg.created_at)}</time>
  `;
  return li;
}

/**
 * Append a message to the list (skips duplicates) and scroll to bottom.
 * @param {{ id: number, text: string, created_at: string }} msg
 */
function appendMessage(msg) {
  if (renderedIds.has(msg.id)) return;
  renderedIds.add(msg.id);

  // Remove empty state if present
  const empty = messagesList.querySelector(".empty-state");
  if (empty) empty.remove();

  messagesList.appendChild(createMessageElement(msg));
  // Auto-scroll to the newest message
  messagesList.parentElement.scrollTop = messagesList.parentElement.scrollHeight;
}

/**
 * Show the empty state placeholder.
 */
function showEmptyState() {
  if (messagesList.children.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-state";
    li.textContent = "No messages yet. Be the first to post!";
    messagesList.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Set connection status badge
// ---------------------------------------------------------------------------
function setStatus(state) {
  statusBadge.className = `status ${state}`;
  const labels = {
    connected: "Connected",
    disconnected: "Connecting…",
    error: "Disconnected",
  };
  statusBadge.textContent = labels[state] || state;
}

// ---------------------------------------------------------------------------
// Fetch historical messages
// ---------------------------------------------------------------------------
async function fetchMessages() {
  try {
    const res = await fetch(`${API_BASE}/api/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    if (messages.length === 0) {
      showEmptyState();
    } else {
      messages.forEach(appendMessage);
    }
  } catch (err) {
    console.error("Failed to fetch messages:", err);
  }
}

// ---------------------------------------------------------------------------
// SSE – Real-time stream
// ---------------------------------------------------------------------------
function connectSSE() {
  const source = new EventSource(`${API_BASE}/api/stream`);

  source.onopen = () => {
    setStatus("connected");
  };

  source.addEventListener("new-message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      appendMessage(msg);
    } catch (err) {
      console.error("Failed to parse SSE message:", err);
    }
  });

  source.onerror = () => {
    setStatus("error");
    // EventSource will auto-reconnect; when it does, onopen fires again.
  };
}

// ---------------------------------------------------------------------------
// Form submission – post a new message
// ---------------------------------------------------------------------------
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  // Optimistically clear the input
  input.value = "";
  input.focus();

  try {
    const res = await fetch(`${API_BASE}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    // The new message will arrive via SSE – no need to manually append.
  } catch (err) {
    console.error("Failed to send message:", err);
    // Put the text back so the user can retry
    input.value = text;
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
fetchMessages();
connectSSE();
