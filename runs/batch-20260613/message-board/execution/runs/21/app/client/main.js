// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const API_BASE =
  import.meta.env.VITE_API_URL || "http://localhost:3001";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const messagesList = document.getElementById("messages");
const form = document.getElementById("form");
const input = document.getElementById("input");
const status = document.getElementById("status");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a timestamp into a human-readable local time string.
 * @param {string} iso
 * @returns {string}
 */
function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString();
}

/**
 * Create a <li> element for a message and return it.
 * @param {{ id: number, text: string, created_at: string }} msg
 * @returns {HTMLLIElement}
 */
function createMessageElement(msg) {
  const li = document.createElement("li");
  li.dataset.id = msg.id;

  const textNode = document.createTextNode(msg.text);
  li.appendChild(textNode);

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = formatTime(msg.created_at);
  li.appendChild(meta);

  return li;
}

/**
 * Scroll the message list to the bottom.
 */
function scrollToBottom() {
  const main = document.querySelector("main");
  main.scrollTop = main.scrollHeight;
}

// ---------------------------------------------------------------------------
// 1. Fetch historical messages on page load
// ---------------------------------------------------------------------------
async function loadMessages() {
  try {
    const res = await fetch(`${API_BASE}/api/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    for (const msg of messages) {
      messagesList.appendChild(createMessageElement(msg));
    }
    scrollToBottom();
  } catch (err) {
    console.error("Failed to load messages:", err);
  }
}

// ---------------------------------------------------------------------------
// 2. Connect to the SSE stream for real-time updates
// ---------------------------------------------------------------------------
function connectSSE() {
  const source = new EventSource(`${API_BASE}/api/stream`);

  source.addEventListener("open", () => {
    status.textContent = "● Connected";
    status.className = "status connected";
  });

  source.addEventListener("new-message", (e) => {
    const msg = JSON.parse(e.data);
    messagesList.appendChild(createMessageElement(msg));
    scrollToBottom();
  });

  source.addEventListener("error", () => {
    status.textContent = "● Reconnecting…";
    status.className = "status error";
  });
}

// ---------------------------------------------------------------------------
// 3. Handle form submission — POST new message
// ---------------------------------------------------------------------------
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  // Clear immediately for a snappy feel.
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
  } catch (err) {
    console.error("Failed to send message:", err);
    // Optionally restore the input value so the user can retry.
    input.value = text;
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadMessages();
connectSSE();
