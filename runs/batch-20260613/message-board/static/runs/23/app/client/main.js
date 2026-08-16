// ── Configuration ─────────────────────────────────────────────────────────
const API_BASE = "http://localhost:3000";

// ── DOM references ────────────────────────────────────────────────────────
/** @type {HTMLUListElement} */
const messageList = /** @type {HTMLUListElement} */ (
  document.getElementById("messages")
);
/** @type {HTMLFormElement} */
const form = /** @type {HTMLFormElement} */ (
  document.getElementById("message-form")
);
/** @type {HTMLInputElement} */
const input = /** @type {HTMLInputElement} */ (
  document.getElementById("message-input")
);

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Format a timestamp for display.
 * @param {string} iso
 * @returns {string}
 */
function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString();
}

/**
 * Create an <li> for a single message and append it to #messages.
 *
 * @param {{ id: number; text: string; created_at: string }} msg
 */
function appendMessage(msg) {
  const li = document.createElement("li");

  const textNode = document.createTextNode(msg.text);
  li.appendChild(textNode);

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = formatTime(msg.created_at);
  li.appendChild(meta);

  messageList.appendChild(li);

  // Auto-scroll to the latest message.
  const main = /** @type {HTMLElement} */ (messageList.closest("main"));
  if (main) {
    main.scrollTop = main.scrollHeight;
  }
}

// ── Fetch historical messages ─────────────────────────────────────────────
async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    /** @type {{ id: number; text: string; created_at: string }[]} */
    const messages = await res.json();
    for (const msg of messages) {
      appendMessage(msg);
    }
  } catch (err) {
    console.error("Failed to load message history:", err);
  }
}

// ── SSE connection ────────────────────────────────────────────────────────
function connectSSE() {
  const source = new EventSource(`${API_BASE}/api/stream`);

  source.addEventListener("new-message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      appendMessage(msg);
    } catch (err) {
      console.error("SSE parse error:", err);
    }
  });

  source.onerror = () => {
    console.warn("SSE connection lost – reconnecting automatically…");
    // EventSource reconnects automatically; nothing to do here.
  };
}

// ── Form submission ───────────────────────────────────────────────────────
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  // Optimistically clear the input.
  input.value = "";

  try {
    const res = await fetch(`${API_BASE}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(/** @type {any} */ (body).error ?? `HTTP ${res.status}`);
    }
    // The new message will arrive via SSE; no need to append it manually.
  } catch (err) {
    console.error("Failed to send message:", err);
    // Restore the text so the user can try again.
    input.value = text;
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────
loadHistory().then(() => {
  connectSSE();
});
