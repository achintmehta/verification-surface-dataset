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
const status = document.getElementById("status");

// Keep track of rendered message IDs to avoid duplicates
const renderedIds = new Set();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a timestamp into a short human-readable string.
 */
function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString();
}

/**
 * Create an <li> element for a message and append it to the list.
 * Automatically scrolls to the bottom so the latest message is visible.
 */
function appendMessage(msg) {
  if (renderedIds.has(msg.id)) return; // deduplicate
  renderedIds.add(msg.id);

  const li = document.createElement("li");

  const textNode = document.createTextNode(msg.text);
  li.appendChild(textNode);

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = formatTime(msg.created_at);
  li.appendChild(meta);

  messagesList.appendChild(li);

  // Auto-scroll to bottom
  const main = messagesList.closest("main");
  main.scrollTop = main.scrollHeight;
}

// ---------------------------------------------------------------------------
// 1. Fetch historical messages on page load
// ---------------------------------------------------------------------------
async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach(appendMessage);
  } catch (err) {
    console.error("Failed to load message history:", err);
  }
}

// ---------------------------------------------------------------------------
// 2. Connect to SSE stream for real-time updates
// ---------------------------------------------------------------------------
function connectSSE() {
  const source = new EventSource(`${API_BASE}/api/stream`);

  source.onopen = () => {
    status.textContent = "Connected ✓";
    status.className = "status connected";
  };

  source.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      appendMessage(msg);
    } catch (err) {
      console.error("Failed to parse SSE message:", err);
    }
  };

  source.onerror = () => {
    status.textContent = "Disconnected – reconnecting…";
    status.className = "status error";
    // EventSource will automatically attempt to reconnect
  };
}

// ---------------------------------------------------------------------------
// 3. Handle form submission – POST new message
// ---------------------------------------------------------------------------
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  const button = form.querySelector("button");
  button.disabled = true;

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

    input.value = "";
  } catch (err) {
    console.error("Failed to send message:", err);
    alert("Failed to send message. Please try again.");
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
