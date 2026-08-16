// ---------------------------------------------------------------------------
// Realtime Message Board – Client
// ---------------------------------------------------------------------------

const API_BASE = "/api";

// DOM references
const messagesList = document.getElementById("messages");
const form = document.getElementById("message-form");
const input = document.getElementById("message-input");
const statusBadge = document.getElementById("connection-status");

// Keep track of rendered message IDs to prevent duplicates
const renderedIds = new Set();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a timestamp into a short, human-readable string.
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
 * Create a <li> element for a message and return it.
 * @param {{ id: number, text: string, created_at: string }} msg
 * @returns {HTMLLIElement}
 */
function createMessageEl(msg) {
  const li = document.createElement("li");
  li.dataset.id = msg.id;

  const textSpan = document.createElement("span");
  textSpan.textContent = msg.text;

  const timeSpan = document.createElement("span");
  timeSpan.className = "msg-time";
  timeSpan.textContent = formatTime(msg.created_at);

  li.appendChild(textSpan);
  li.appendChild(timeSpan);
  return li;
}

/**
 * Remove the "no messages yet" placeholder if it exists.
 */
function removeEmptyState() {
  const placeholder = messagesList.querySelector(".empty-state");
  if (placeholder) placeholder.remove();
}

/**
 * Show an empty-state message when there are no messages.
 */
function showEmptyState() {
  if (messagesList.children.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-state";
    li.textContent = "No messages yet — be the first to post!";
    messagesList.appendChild(li);
  }
}

/**
 * Append a single message to the list, scrolling to the bottom.
 * Skips if the message ID has already been rendered.
 * @param {{ id: number, text: string, created_at: string }} msg
 */
function appendMessage(msg) {
  if (renderedIds.has(msg.id)) return;
  renderedIds.add(msg.id);
  removeEmptyState();

  const el = createMessageEl(msg);
  messagesList.appendChild(el);

  // Auto-scroll to the newest message
  el.scrollIntoView({ behavior: "smooth", block: "end" });
}

// ---------------------------------------------------------------------------
// 1. Fetch message history on page load
// ---------------------------------------------------------------------------

async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();

    if (messages.length === 0) {
      showEmptyState();
    } else {
      messages.forEach(appendMessage);
    }
  } catch (err) {
    console.error("Failed to load message history:", err);
  }
}

// ---------------------------------------------------------------------------
// 2. SSE – real-time updates
// ---------------------------------------------------------------------------

function connectSSE() {
  const es = new EventSource(`${API_BASE}/stream`);

  es.onopen = () => {
    statusBadge.textContent = "Connected";
    statusBadge.className = "status connected";
  };

  es.addEventListener("new_message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      appendMessage(msg);
    } catch (err) {
      console.error("Failed to parse SSE message:", err);
    }
  });

  es.onerror = () => {
    statusBadge.textContent = "Reconnecting…";
    statusBadge.className = "status disconnected";
    // EventSource will automatically attempt to reconnect
  };
}

// ---------------------------------------------------------------------------
// 3. Form submission – post a new message
// ---------------------------------------------------------------------------

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  const button = form.querySelector("button");
  button.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }

    // Clear the input on success
    input.value = "";
  } catch (err) {
    console.error("Failed to send message:", err);
    alert("Could not send message. Please try again.");
  } finally {
    button.disabled = false;
    input.focus();
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadHistory();
connectSSE();
