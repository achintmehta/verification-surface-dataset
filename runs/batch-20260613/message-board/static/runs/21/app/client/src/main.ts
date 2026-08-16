import { fetchMessages, postMessage } from "./api.js";
import type { Message } from "./api.js";
import { connectSSE } from "./sse.js";

// ---------------------------------------------------------------------------
//  DOM references
// ---------------------------------------------------------------------------
const messageList = document.getElementById("message-list") as HTMLUListElement;
const messageForm = document.getElementById("message-form") as HTMLFormElement;
const messageInput = document.getElementById(
  "message-input"
) as HTMLInputElement;

// Keep track of rendered message IDs so we don't duplicate on SSE echo-back.
const renderedIds = new Set<number>();

// ---------------------------------------------------------------------------
//  Rendering helpers
// ---------------------------------------------------------------------------

/** Format an ISO timestamp into a short locale string. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Create a <li> element for a message and append it to the list. */
function renderMessage(msg: Message): void {
  if (renderedIds.has(msg.id)) return;
  renderedIds.add(msg.id);

  const li = document.createElement("li");

  const textSpan = document.createElement("span");
  textSpan.textContent = msg.text;

  const timeSpan = document.createElement("span");
  timeSpan.className = "timestamp";
  timeSpan.textContent = formatTime(msg.created_at);

  li.appendChild(textSpan);
  li.appendChild(timeSpan);
  messageList.appendChild(li);

  // Auto-scroll to the latest message
  li.scrollIntoView({ behavior: "smooth", block: "end" });
}

// ---------------------------------------------------------------------------
//  Initialisation
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  // 1. Load historical messages
  try {
    const messages = await fetchMessages();
    for (const msg of messages) {
      renderMessage(msg);
    }
  } catch (err) {
    console.error("Failed to load message history:", err);
  }

  // 2. Open SSE stream for real-time updates
  connectSSE((msg) => {
    renderMessage(msg);
  });

  // 3. Handle form submissions
  messageForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = messageInput.value.trim();
    if (!text) return;

    messageInput.value = "";
    messageInput.focus();

    try {
      await postMessage(text);
    } catch (err) {
      console.error("Failed to send message:", err);
    }
  });
}

init();
