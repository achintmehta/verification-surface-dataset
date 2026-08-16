// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const API_BASE = "http://localhost:3001/api";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render a single message object as an `<li>` element and append it to the
 * message list. Automatically scrolls to the bottom so the newest message is
 * visible.
 *
 * @param {{ id: number; text: string; created_at: string }} message
 */
function appendMessage(message) {
  const li = document.createElement("li");

  const textSpan = document.createElement("span");
  textSpan.className = "message-text";
  textSpan.textContent = message.text;

  const timeSpan = document.createElement("span");
  timeSpan.className = "message-time";
  timeSpan.textContent = new Date(message.created_at).toLocaleString();

  li.appendChild(textSpan);
  li.appendChild(timeSpan);
  messageList.appendChild(li);

  // Auto-scroll to the latest message.
  messageList.scrollTop = messageList.scrollHeight;
}

// ---------------------------------------------------------------------------
// 1. Fetch historical messages on page load
// ---------------------------------------------------------------------------

async function loadMessages() {
  try {
    const res = await fetch(`${API_BASE}/messages`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    /** @type {Array<{ id: number; text: string; created_at: string }>} */
    const messages = await res.json();
    for (const msg of messages) {
      appendMessage(msg);
    }
  } catch (err) {
    console.error("Failed to load messages:", err);
  }
}

// ---------------------------------------------------------------------------
// 2. Connect to SSE stream for real-time updates
// ---------------------------------------------------------------------------

/** Set of message IDs we have already rendered (to avoid duplicates). */
const renderedIds = new Set();

function connectSSE() {
  const source = new EventSource(`${API_BASE}/stream`);

  source.addEventListener("new-message", (event) => {
    /** @type {{ id: number; text: string; created_at: string }} */
    const message = JSON.parse(event.data);

    // Guard against duplicates – the POST response may have already rendered it
    // before the SSE event arrives.
    if (renderedIds.has(message.id)) return;
    renderedIds.add(message.id);
    appendMessage(message);
  });

  source.onerror = () => {
    console.warn("SSE connection lost. The browser will auto-reconnect.");
  };
}

// ---------------------------------------------------------------------------
// 3. Handle form submission
// ---------------------------------------------------------------------------

/**
 * Send a message to the server and render it on success.
 * Returns `true` if the message was sent successfully, `false` otherwise.
 *
 * @param {string} text – The message text to send.
 * @returns {Promise<boolean>}
 */
async function sendMessage(text) {
  try {
    const res = await fetch(`${API_BASE}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    /** @type {{ id: number; text: string; created_at: string }} */
    const message = await res.json();

    // Render immediately from the POST response (SSE guard prevents dupes).
    renderedIds.add(message.id);
    appendMessage(message);
    return true;
  } catch (err) {
    console.error("Failed to send message:", err);
    return false;
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  const submitBtn = /** @type {HTMLButtonElement} */ (
    form.querySelector("button")
  );
  submitBtn.disabled = true;
  input.value = "";

  sendMessage(text).then((success) => {
    // Put the text back so the user can retry on failure.
    if (!success) {
      input.value = text;
    }
    submitBtn.disabled = false;
    input.focus();
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadMessages().then(() => {
  // Historical messages are loaded before the SSE connection is opened, so
  // they won't cause duplicates – SSE only emits events for new inserts that
  // occur after the connection is established.
  connectSSE();
});
