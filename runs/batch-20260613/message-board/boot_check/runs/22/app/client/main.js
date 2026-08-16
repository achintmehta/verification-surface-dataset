const messagesList = document.getElementById("messages");
const form = document.getElementById("message-form");
const input = document.getElementById("message-input");
const statusEl = document.getElementById("status");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString();
}

function createMessageElement(msg) {
  const li = document.createElement("li");

  const textSpan = document.createElement("span");
  textSpan.className = "msg-text";
  textSpan.textContent = msg.text;

  const timeSpan = document.createElement("span");
  timeSpan.className = "msg-time";
  timeSpan.textContent = formatTime(msg.created_at);

  li.appendChild(textSpan);
  li.appendChild(timeSpan);
  return li;
}

function appendMessage(msg) {
  const li = createMessageElement(msg);
  messagesList.appendChild(li);
  // Scroll to bottom of the message list
  li.scrollIntoView({ behavior: "smooth", block: "end" });
}

// Keep track of message IDs we've already rendered to avoid duplicates
const renderedIds = new Set();

function appendMessageOnce(msg) {
  if (renderedIds.has(msg.id)) return;
  renderedIds.add(msg.id);
  appendMessage(msg);
}

// ---------------------------------------------------------------------------
// Fetch historical messages on page load
// ---------------------------------------------------------------------------

async function loadHistory() {
  try {
    const res = await fetch("/api/messages");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const messages = await res.json();
    messages.forEach(appendMessageOnce);
  } catch (err) {
    console.error("Failed to load message history:", err);
  }
}

// ---------------------------------------------------------------------------
// SSE – real-time updates
// ---------------------------------------------------------------------------

function connectSSE() {
  const evtSource = new EventSource("/api/stream");

  evtSource.onopen = () => {
    statusEl.textContent = "● Connected";
    statusEl.classList.add("connected");
  };

  evtSource.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      appendMessageOnce(msg);
    } catch (err) {
      console.error("Failed to parse SSE message:", err);
    }
  };

  evtSource.onerror = () => {
    statusEl.textContent = "Reconnecting…";
    statusEl.classList.remove("connected");
    // EventSource will automatically attempt to reconnect
  };
}

// ---------------------------------------------------------------------------
// Form submission – POST new message
// ---------------------------------------------------------------------------

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  const submitBtn = form.querySelector("button");
  submitBtn.disabled = true;

  try {
    const res = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    input.value = "";
  } catch (err) {
    console.error("Failed to send message:", err);
    alert("Failed to send message. Please try again.");
  } finally {
    submitBtn.disabled = false;
    input.focus();
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadHistory();
connectSSE();
