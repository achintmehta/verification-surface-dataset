// ---------------------------------------------------------------------------
//  Configuration
// ---------------------------------------------------------------------------
const API_BASE = import.meta.env.VITE_API_BASE || "";

// ---------------------------------------------------------------------------
//  DOM references
// ---------------------------------------------------------------------------
const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("form");
const inputEl = document.getElementById("input");
const statusEl = document.getElementById("status");

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/** Keep track of rendered message IDs so we never render duplicates. */
const renderedIds = new Set();

/**
 * Create a <li> element for a message object and append it to the list.
 * @param {{ id: number, text: string, created_at: string }} msg
 */
function renderMessage(msg) {
  if (renderedIds.has(msg.id)) return;
  renderedIds.add(msg.id);

  const li = document.createElement("li");
  li.dataset.id = msg.id;

  const textNode = document.createTextNode(msg.text);
  li.appendChild(textNode);

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = new Date(msg.created_at).toLocaleString();
  li.appendChild(meta);

  messagesEl.appendChild(li);

  // Scroll to the bottom so newest messages are visible
  li.scrollIntoView({ behavior: "smooth", block: "end" });
}

function setStatus(text, className) {
  statusEl.textContent = text;
  statusEl.className = `status ${className}`;
}

// ---------------------------------------------------------------------------
//  1. Fetch historical messages
// ---------------------------------------------------------------------------

async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach(renderMessage);
  } catch (err) {
    console.error("Failed to load message history:", err);
  }
}

// ---------------------------------------------------------------------------
//  2. Connect to SSE stream
// ---------------------------------------------------------------------------

function connectSSE() {
  const source = new EventSource(`${API_BASE}/api/stream`);

  source.onopen = () => {
    setStatus("Connected", "connected");
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
    setStatus("Disconnected – reconnecting…", "disconnected");
    // EventSource will automatically try to reconnect.
  };
}

// ---------------------------------------------------------------------------
//  3. Form submission – POST new message
// ---------------------------------------------------------------------------

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();

  const text = inputEl.value.trim();
  if (!text) return;

  // Optimistically clear the input
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
      console.error("Failed to post message:", body.error || res.statusText);
    }
  } catch (err) {
    console.error("Network error posting message:", err);
  }
});

// ---------------------------------------------------------------------------
//  Boot
// ---------------------------------------------------------------------------

loadHistory().then(() => {
  connectSSE();
});
