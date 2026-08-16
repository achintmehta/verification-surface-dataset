const API_BASE = "http://localhost:3000";

const messagesList = document.getElementById("messages");
const form = document.getElementById("message-form");
const input = document.getElementById("message-input");

// ── Helpers ──────────────────────────────────────────────────────────

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function createMessageElement(msg) {
  const li = document.createElement("li");
  li.setAttribute("data-id", msg.id);

  const textNode = document.createTextNode(msg.text);
  li.appendChild(textNode);

  const time = document.createElement("span");
  time.className = "time";
  time.textContent = formatTime(msg.created_at);
  li.appendChild(time);

  return li;
}

function appendMessage(msg) {
  const li = createMessageElement(msg);
  messagesList.appendChild(li);
  // Auto-scroll to the latest message
  li.scrollIntoView({ behavior: "smooth", block: "end" });
}

// ── Fetch historical messages ────────────────────────────────────────

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

// ── SSE connection ───────────────────────────────────────────────────

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
    // EventSource reconnects automatically by default
  };
}

// ── Form submission ──────────────────────────────────────────────────

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  input.focus();

  try {
    const res = await fetch(`${API_BASE}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const err = await res.json();
      console.error("Failed to post message:", err);
    }
  } catch (err) {
    console.error("Failed to post message:", err);
  }
});

// ── Init ─────────────────────────────────────────────────────────────

loadHistory();
connectSSE();
