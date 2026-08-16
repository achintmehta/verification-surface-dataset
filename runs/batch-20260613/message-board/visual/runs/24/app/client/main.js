// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const API_BASE = "http://localhost:3001";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const messagesContainer = document.getElementById("messages");
const form = document.getElementById("message-form");
const input = document.getElementById("message-input");

// Keep track of rendered message IDs so we don't duplicate
const renderedIds = new Set();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a timestamp string into a human-readable time.
 * @param {string} iso
 * @returns {string}
 */
function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString();
}

/**
 * Create a DOM element for a single message.
 * @param {{ id: number, text: string, created_at: string }} msg
 * @returns {HTMLElement}
 */
function createMessageElement(msg) {
  const el = document.createElement("div");
  el.classList.add("message");
  el.dataset.id = msg.id;

  const textSpan = document.createElement("span");
  textSpan.classList.add("message-text");
  textSpan.textContent = msg.text;

  const timeSpan = document.createElement("small");
  timeSpan.classList.add("message-time");
  timeSpan.textContent = formatTime(msg.created_at);

  el.appendChild(textSpan);
  el.appendChild(timeSpan);

  return el;
}

/**
 * Append a message to the container (if not already rendered) and
 * scroll to the bottom.
 * @param {{ id: number, text: string, created_at: string }} msg
 */
function appendMessage(msg) {
  if (renderedIds.has(msg.id)) return;
  renderedIds.add(msg.id);

  // Remove empty state if present
  const empty = messagesContainer.querySelector(".empty-state");
  if (empty) empty.remove();

  const el = createMessageElement(msg);
  messagesContainer.appendChild(el);

  // Scroll the messages container into view
  const main = messagesContainer.closest("main");
  if (main) {
    main.scrollTop = main.scrollHeight;
  }
}

// ---------------------------------------------------------------------------
// Fetch historical messages on page load
// ---------------------------------------------------------------------------
async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const messages = await res.json();

    if (messages.length === 0) {
      messagesContainer.innerHTML =
        '<p class="empty-state">No messages yet. Be the first to post!</p>';
    } else {
      messages.forEach(appendMessage);
    }
  } catch (err) {
    console.error("Failed to load message history:", err);
    messagesContainer.innerHTML =
      '<p class="empty-state">Could not load messages. Is the server running?</p>';
  }
}

// ---------------------------------------------------------------------------
// SSE – Connect to the real-time stream
// ---------------------------------------------------------------------------
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

  source.onerror = (err) => {
    console.warn("SSE connection error, browser will auto-reconnect:", err);
  };
}

// ---------------------------------------------------------------------------
// Form submission – POST a new message
// ---------------------------------------------------------------------------
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  // Disable form while sending
  input.disabled = true;
  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

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

    // Clear input on success
    input.value = "";
  } catch (err) {
    console.error("Failed to send message:", err);
    alert("Failed to send message. Please try again.");
  } finally {
    input.disabled = false;
    submitBtn.disabled = false;
    input.focus();
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadHistory();
connectSSE();
