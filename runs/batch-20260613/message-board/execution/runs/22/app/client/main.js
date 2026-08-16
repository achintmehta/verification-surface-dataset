// ── Configuration ────────────────────────────
const API_BASE =
  import.meta.env.VITE_API_URL || "http://localhost:3000";

// ── DOM references ───────────────────────────
const messagesList = document.getElementById("messages");
const form = document.getElementById("message-form");
const input = document.getElementById("message-input");

// ── Helpers ──────────────────────────────────
/** Format an ISO timestamp into a short, readable string. */
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
 * Turn a message object into an <li> element and append it to the list.
 * Automatically scrolls to the bottom so the latest message is visible.
 */
function appendMessage(msg) {
  const li = document.createElement("li");
  li.setAttribute("data-id", msg.id);

  const textNode = document.createTextNode(msg.text);
  li.appendChild(textNode);

  const time = document.createElement("span");
  time.className = "time";
  time.textContent = formatTime(msg.created_at);
  li.appendChild(time);

  messagesList.appendChild(li);

  // Scroll the message area to the bottom.
  const main = messagesList.closest("main");
  main.scrollTop = main.scrollHeight;
}

// ── 1. Fetch historical messages ─────────────
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

// ── 2. Connect to SSE stream ─────────────────
function connectSSE() {
  const source = new EventSource(`${API_BASE}/api/stream`);

  source.addEventListener("new-message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      appendMessage(msg);
    } catch (err) {
      console.error("Bad SSE payload:", err);
    }
  });

  source.onerror = () => {
    // EventSource will automatically attempt to reconnect.
    console.warn("SSE connection lost – reconnecting…");
  };
}

// ── 3. Handle form submission ────────────────
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  // Optimistically clear the input.
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
    // The SSE stream will deliver the message to all clients (including us).
  } catch (err) {
    console.error("Failed to send message:", err);
    // Restore the text so the user can retry.
    input.value = text;
  }
});

// ── Boot ─────────────────────────────────────
loadHistory().then(() => connectSSE());
