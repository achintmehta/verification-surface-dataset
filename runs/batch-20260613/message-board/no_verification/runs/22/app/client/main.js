// ─── DOM references ──────────────────────────────────────────────────────
const messagesList = document.getElementById("messages");
const form = document.getElementById("form");
const input = document.getElementById("input");
const status = document.getElementById("status");

// Keep track of rendered message IDs so we don't duplicate them
const renderedIds = new Set();

// ─── Helpers ─────────────────────────────────────────────────────────────

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
 * Create a <li> element for a message and append it to the list.
 * Automatically scrolls to the bottom.
 *
 * @param {{ id: number, text: string, created_at: string }} msg
 */
function appendMessage(msg) {
  if (renderedIds.has(msg.id)) return;
  renderedIds.add(msg.id);

  const li = document.createElement("li");

  const textSpan = document.createElement("span");
  textSpan.textContent = msg.text;

  const timeSpan = document.createElement("span");
  timeSpan.className = "time";
  timeSpan.textContent = formatTime(msg.created_at);

  li.appendChild(textSpan);
  li.appendChild(timeSpan);
  messagesList.appendChild(li);

  // Scroll the message list to the bottom
  li.scrollIntoView({ behavior: "smooth", block: "end" });
}

// ─── Load historical messages ────────────────────────────────────────────

async function loadHistory() {
  try {
    const res = await fetch("/api/messages");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach(appendMessage);
  } catch (err) {
    console.error("Failed to load message history:", err);
  }
}

// ─── SSE connection ──────────────────────────────────────────────────────

function connectSSE() {
  const evtSource = new EventSource("/api/stream");

  evtSource.onopen = () => {
    status.textContent = "🟢 Connected";
    status.className = "status connected";
  };

  evtSource.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      appendMessage(msg);
    } catch (err) {
      console.error("Failed to parse SSE message:", err);
    }
  };

  evtSource.onerror = () => {
    status.textContent = "🔴 Disconnected – reconnecting…";
    status.className = "status error";
    // EventSource will automatically attempt to reconnect
  };
}

// ─── Form submission ─────────────────────────────────────────────────────

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  const button = form.querySelector("button");
  button.disabled = true;

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

    // Clear input on success — the message itself will arrive via SSE
    input.value = "";
  } catch (err) {
    console.error("Failed to send message:", err);
    alert("Failed to send message. Please try again.");
  } finally {
    button.disabled = false;
    input.focus();
  }
});

// ─── Bootstrap ───────────────────────────────────────────────────────────

loadHistory();
connectSSE();
