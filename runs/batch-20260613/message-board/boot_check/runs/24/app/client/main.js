const API_BASE = window.location.port === "5173"
  ? "http://localhost:3000"
  : "";

const messagesList = document.getElementById("messages");
const form = document.getElementById("message-form");
const input = document.getElementById("message-input");

// ── Helpers ───────────────────────────────────────────────────────────

/** Track rendered message IDs to avoid duplicates */
const renderedIds = new Set();

function formatTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleString();
}

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

function appendMessage(msg) {
  if (renderedIds.has(msg.id)) return; // skip duplicates
  renderedIds.add(msg.id);

  const el = createMessageElement(msg);
  messagesList.appendChild(el);

  // Auto-scroll to bottom
  const main = document.querySelector("main");
  main.scrollTop = main.scrollHeight;
}

// ── Fetch initial messages ────────────────────────────────────────────

async function loadMessages() {
  try {
    const res = await fetch(`${API_BASE}/api/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach(appendMessage);
  } catch (err) {
    console.error("Failed to load messages:", err);
  }
}

// ── SSE connection ────────────────────────────────────────────────────

function connectSSE() {
  const source = new EventSource(`${API_BASE}/api/stream`);

  source.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      appendMessage(msg);
    } catch (err) {
      console.error("Failed to parse SSE message:", err);
    }
  };

  source.onerror = () => {
    console.warn("SSE connection lost. Reconnecting…");
    // EventSource will automatically attempt to reconnect
  };
}

// ── Form submission ───────────────────────────────────────────────────

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
    alert("Could not send message. Please try again.");
  } finally {
    button.disabled = false;
    input.focus();
  }
});

// ── Boot ──────────────────────────────────────────────────────────────

loadMessages();
connectSSE();
