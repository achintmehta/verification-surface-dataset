// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const API_BASE = "http://localhost:3001";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const messageList = document.getElementById("messages");
const form = document.getElementById("form");
const input = document.getElementById("input");
const status = document.getElementById("status");

// Keep track of rendered message IDs to avoid duplicates
const renderedIds = new Set();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO date string into a human-friendly local time string.
 * @param {string} iso
 * @returns {string}
 */
function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString();
}

/**
 * Create a <li> element for a single message.
 * @param {{ id: number, text: string, created_at: string }} msg
 * @returns {HTMLLIElement}
 */
function createMessageEl(msg) {
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

/**
 * Append a message to the list (if not already rendered) and scroll to bottom.
 * @param {{ id: number, text: string, created_at: string }} msg
 */
function appendMessage(msg) {
  if (renderedIds.has(msg.id)) return;
  renderedIds.add(msg.id);

  // Remove empty-state placeholder if present
  const empty = messageList.querySelector(".empty-state");
  if (empty) empty.remove();

  messageList.appendChild(createMessageEl(msg));

  // Scroll to the newest message
  const main = messageList.closest("main");
  if (main) main.scrollTop = main.scrollHeight;
}

function showEmpty() {
  if (messageList.children.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-state";
    li.textContent = "No messages yet. Be the first to post!";
    messageList.appendChild(li);
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
    messages.forEach(appendMessage);
    showEmpty();
  } catch (err) {
    console.error("[loadHistory]", err);
  }
}

// ---------------------------------------------------------------------------
// 2. SSE – real-time updates
// ---------------------------------------------------------------------------
function connectSSE() {
  const es = new EventSource(`${API_BASE}/api/stream`);

  es.onopen = () => {
    status.textContent = "Connected";
    status.className = "status status--connected";
  };

  es.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      appendMessage(msg);
    } catch (err) {
      console.error("[SSE parse]", err);
    }
  };

  es.onerror = () => {
    status.textContent = "Reconnecting…";
    status.className = "status status--error";
    // EventSource will automatically attempt to reconnect
  };
}

// ---------------------------------------------------------------------------
// 3. Form submission
// ---------------------------------------------------------------------------
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  const btn = form.querySelector("button");
  btn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Clear the input on success
    input.value = "";
  } catch (err) {
    console.error("[post]", err);
    alert("Failed to send message. Please try again.");
  } finally {
    btn.disabled = false;
    input.focus();
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadHistory();
connectSSE();
