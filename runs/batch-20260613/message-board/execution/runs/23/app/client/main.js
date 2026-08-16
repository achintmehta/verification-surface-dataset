// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const messagesList = document.getElementById("messages");
const form = document.getElementById("form");
const input = document.getElementById("input");
const status = document.getElementById("status");

// We keep track of rendered message IDs to avoid duplicates
// (the POST response could arrive after the SSE broadcast).
const renderedIds = new Set();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format an ISO date string into a human-friendly local time. */
function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString();
}

/** Create a <li> element for a single message. */
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

/** Append a message to the list if it hasn't already been rendered. */
function appendMessage(msg) {
  if (renderedIds.has(msg.id)) return;
  renderedIds.add(msg.id);
  const li = createMessageElement(msg);
  messagesList.appendChild(li);
  // Auto-scroll to the bottom
  li.scrollIntoView({ behavior: "smooth", block: "end" });
}

// ---------------------------------------------------------------------------
// 1. Fetch historical messages on page load
// ---------------------------------------------------------------------------
async function loadHistory() {
  try {
    const res = await fetch("/api/messages");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    for (const msg of messages) {
      appendMessage(msg);
    }
  } catch (err) {
    console.error("Failed to load message history:", err);
  }
}

// ---------------------------------------------------------------------------
// 2. Connect to SSE stream for real-time updates
// ---------------------------------------------------------------------------
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
    // EventSource automatically attempts to reconnect.
  };
}

// ---------------------------------------------------------------------------
// 3. Handle form submission – POST new message
// ---------------------------------------------------------------------------
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  // Clear immediately for snappy UX
  input.value = "";
  input.focus();

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

    // The SSE broadcast will handle rendering, but we also append here
    // for the fastest possible feedback in case SSE is slightly delayed.
    const msg = await res.json();
    appendMessage(msg);
  } catch (err) {
    console.error("Failed to send message:", err);
    // Put the text back so the user can retry
    input.value = text;
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadHistory();
connectSSE();
