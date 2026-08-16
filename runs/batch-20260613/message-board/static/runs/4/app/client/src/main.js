/**
 * main.js – Vanilla JS frontend for the Message Board.
 *
 * Responsibilities:
 *  1. Fetch historical messages from GET /api/messages on page load.
 *  2. Render each message into the #message-list <ul>.
 *  3. Open an EventSource to GET /api/stream and append incoming messages.
 *  4. Handle form submission: POST to /api/messages, then clear the input.
 *  5. Keep the status indicator in sync with the SSE connection state.
 */

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const messageList    = /** @type {HTMLUListElement}   */ (document.getElementById("message-list"));
const emptyState     = /** @type {HTMLParagraphElement}*/ (document.getElementById("empty-state"));
const postForm       = /** @type {HTMLFormElement}    */ (document.getElementById("post-form"));
const messageInput   = /** @type {HTMLInputElement}   */ (document.getElementById("message-input"));
const submitBtn      = /** @type {HTMLButtonElement}  */ (postForm.querySelector(".post-form__btn"));
const statusEl       = /** @type {HTMLSpanElement}    */ (document.getElementById("status-indicator"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO timestamp into a human-readable local time string.
 * @param {string} isoString
 * @returns {string}
 */
function formatTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString(undefined, {
    month:  "short",
    day:    "numeric",
    hour:   "2-digit",
    minute: "2-digit",
  });
}

/**
 * Derive a deterministic hue from a message id so each avatar has a
 * consistent colour without needing user accounts.
 * @param {number} id
 * @returns {string} CSS hsl() colour
 */
function avatarColor(id) {
  const hue = (id * 47) % 360;
  return `hsl(${hue}, 60%, 45%)`;
}

/**
 * Build and return a <li> element for a single message.
 *
 * @param {{ id: number, text: string, created_at: string }} message
 * @returns {HTMLLIElement}
 */
function createMessageElement(message) {
  const li = document.createElement("li");
  li.className = "message-item";
  li.dataset.id = String(message.id);

  const avatarLetter = `#${message.id}`;

  li.innerHTML = `
    <div class="message-item__avatar" style="background:${avatarColor(message.id)}" aria-hidden="true">
      ${message.id}
    </div>
    <div class="message-item__body">
      <div class="message-item__meta">
        <span class="message-item__id">Message #${message.id}</span>
        <time class="message-item__time" datetime="${message.created_at}">
          ${formatTime(message.created_at)}
        </time>
      </div>
      <p class="message-item__text">${escapeHtml(message.text)}</p>
    </div>
  `;

  // Suppress the unused variable warning – avatarLetter is intentionally
  // replaced by the numeric id in the template above.
  void avatarLetter;

  return li;
}

/**
 * Escape a string so it is safe to inject into innerHTML.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Append a message to the list and scroll to the bottom.
 * Also hides the empty-state placeholder if it was visible.
 *
 * @param {{ id: number, text: string, created_at: string }} message
 */
function appendMessage(message) {
  emptyState.hidden = true;
  const li = createMessageElement(message);
  messageList.appendChild(li);
  // Scroll the new message into view.
  li.scrollIntoView({ behavior: "smooth", block: "end" });
}

/**
 * Update the connection status badge.
 * @param {"connecting" | "connected" | "error"} state
 * @param {string} [label]
 */
function setStatus(state, label) {
  statusEl.className = `status status--${state}`;
  const icons = { connecting: "●", connected: "●", error: "●" };
  const labels = {
    connecting: "Connecting…",
    connected:  "Live",
    error:      "Disconnected",
  };
  statusEl.textContent = `${icons[state]} ${label ?? labels[state]}`;
}

// ---------------------------------------------------------------------------
// 1 & 2 – Fetch and render historical messages
// ---------------------------------------------------------------------------

async function loadHistory() {
  try {
    const res = await fetch("/api/messages");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    /** @type {{ id: number, text: string, created_at: string }[]} */
    const messages = await res.json();

    if (messages.length === 0) {
      emptyState.hidden = false;
    } else {
      emptyState.hidden = true;
      for (const msg of messages) {
        const li = createMessageElement(msg);
        messageList.appendChild(li);
      }
      // Scroll to the bottom after the initial render.
      messageList.lastElementChild?.scrollIntoView({ block: "end" });
    }
  } catch (err) {
    console.error("[history] Failed to load messages:", err);
    emptyState.hidden = false;
    emptyState.textContent = "⚠️ Could not load messages. Is the server running?";
  }
}

// ---------------------------------------------------------------------------
// 3 & 4 – SSE connection and real-time message handling
// ---------------------------------------------------------------------------

/**
 * Open an EventSource connection to /api/stream.
 * The browser will automatically reconnect on transient failures.
 */
function connectSSE() {
  setStatus("connecting");

  const source = new EventSource("/api/stream");

  // The server sends a `connected` event as soon as the stream is open.
  source.addEventListener("connected", () => {
    console.log("[sse] Stream connected.");
    setStatus("connected");
  });

  // Every new message is broadcast as a `message` event with a JSON payload.
  source.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      // Avoid duplicates: the sender already sees the message via the POST
      // response, but we still append it here because the POST response is
      // handled separately and we want a single source of truth for rendering.
      // Duplicate guard: skip if this id is already in the list.
      if (messageList.querySelector(`[data-id="${message.id}"]`)) return;
      appendMessage(message);
    } catch (err) {
      console.error("[sse] Failed to parse message event:", err);
    }
  });

  source.addEventListener("error", () => {
    // EventSource will retry automatically; just update the badge.
    setStatus("error");
    console.warn("[sse] Connection lost – browser will retry.");
  });

  // When the browser successfully reconnects after an error, the `connected`
  // event fires again and resets the badge to "Live".
}

// ---------------------------------------------------------------------------
// 5 – Form submission
// ---------------------------------------------------------------------------

postForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const text = messageInput.value.trim();
  if (!text) return;

  // Disable the form while the request is in flight.
  submitBtn.disabled = true;
  messageInput.disabled = true;

  try {
    const res = await fetch("/api/messages", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ text }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }

    // Clear the input on success.  The SSE broadcast will render the message.
    messageInput.value = "";
  } catch (err) {
    console.error("[post] Failed to send message:", err);
    alert(`Failed to send message: ${err.message}`);
  } finally {
    submitBtn.disabled = false;
    messageInput.disabled = false;
    messageInput.focus();
  }
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

loadHistory();
connectSSE();
