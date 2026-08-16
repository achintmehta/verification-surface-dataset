// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const API_BASE = "http://localhost:3001";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("form");
const inputEl = document.getElementById("input");
const statusEl = document.getElementById("status");

// Keep track of rendered message IDs so we don't duplicate
const renderedIds = new Set();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a timestamp string into a short human-readable form.
 * @param {string} iso
 */
function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString();
}

/**
 * Create a <li> for a message and append it to the list.
 * Optionally scrolls to the bottom.
 *
 * @param {{ id: number, text: string, created_at: string }} msg
 * @param {boolean} scroll
 */
function renderMessage(msg, scroll = true) {
  if (renderedIds.has(msg.id)) return; // deduplicate
  renderedIds.add(msg.id);

  const li = document.createElement("li");
  li.setAttribute("data-id", msg.id);

  const textNode = document.createTextNode(msg.text);
  li.appendChild(textNode);

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = formatTime(msg.created_at);
  li.appendChild(meta);

  messagesEl.appendChild(li);

  if (scroll) {
    li.scrollIntoView({ behavior: "smooth", block: "end" });
  }
}

// ---------------------------------------------------------------------------
// 1. Fetch historical messages
// ---------------------------------------------------------------------------
async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach((m) => renderMessage(m, false));

    // Scroll to bottom after loading history
    if (messagesEl.lastElementChild) {
      messagesEl.lastElementChild.scrollIntoView({ block: "end" });
    }
  } catch (err) {
    console.error("Failed to load history:", err);
  }
}

// ---------------------------------------------------------------------------
// 2. Connect to SSE stream
// ---------------------------------------------------------------------------
function connectSSE() {
  const source = new EventSource(`${API_BASE}/api/stream`);

  source.onopen = () => {
    statusEl.textContent = "🟢 Connected";
    statusEl.className = "status connected";
  };

  source.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      renderMessage(msg);
    } catch (err) {
      console.error("Failed to parse SSE message:", err);
    }
  };

  source.onerror = () => {
    statusEl.textContent = "🔴 Disconnected – reconnecting…";
    statusEl.className = "status error";
    // EventSource automatically reconnects, so we just update status
  };
}

// ---------------------------------------------------------------------------
// 3. Handle form submission
// ---------------------------------------------------------------------------
formEl.addEventListener("submit", async (e) => {
  e.preventDefault();

  const text = inputEl.value.trim();
  if (!text) return;

  // Clear and refocus immediately for snappy UX
  inputEl.value = "";
  inputEl.focus();

  try {
    const res = await fetch(`${API_BASE}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error("Post failed:", body);
    }
    // The message will appear via SSE broadcast – no need to manually append
  } catch (err) {
    console.error("Failed to send message:", err);
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadHistory().then(() => connectSSE());
