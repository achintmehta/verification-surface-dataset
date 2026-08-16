// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const messagesList = document.getElementById("messages");
const statusEl = document.getElementById("status");
const form = document.getElementById("form");
const input = document.getElementById("input");

// We track rendered message IDs to avoid duplicates
const renderedIds = new Set();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a timestamp string into a human-friendly local time.
 * @param {string} iso
 * @returns {string}
 */
function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString();
}

/**
 * Append a single message object to the DOM list.
 * @param {{ id: number, text: string, created_at: string }} msg
 */
function appendMessage(msg) {
  if (renderedIds.has(msg.id)) return; // prevent duplicates
  renderedIds.add(msg.id);

  const li = document.createElement("li");
  li.textContent = msg.text;

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = formatTime(msg.created_at);
  li.appendChild(meta);

  messagesList.appendChild(li);

  // Auto-scroll to bottom
  messagesList.scrollTop = messagesList.scrollHeight;
}

// ---------------------------------------------------------------------------
// Fetch initial message history
// ---------------------------------------------------------------------------
async function fetchHistory() {
  try {
    const res = await fetch("/api/messages");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach(appendMessage);
  } catch (err) {
    console.error("Failed to fetch message history:", err);
  }
}

// ---------------------------------------------------------------------------
// SSE – Real-time stream
// ---------------------------------------------------------------------------
function connectSSE() {
  const source = new EventSource("/api/stream");

  source.onopen = () => {
    statusEl.textContent = "🟢 Connected";
    statusEl.className = "connected";
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
    statusEl.textContent = "🔴 Disconnected – reconnecting…";
    statusEl.className = "error";
    // EventSource will automatically try to reconnect
  };
}

// ---------------------------------------------------------------------------
// Form submission – Post a new message
// ---------------------------------------------------------------------------
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  const btn = form.querySelector("button");
  btn.disabled = true;

  try {
    const res = await fetch("/api/messages", {
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
    btn.disabled = false;
    input.focus();
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
fetchHistory();
connectSSE();
