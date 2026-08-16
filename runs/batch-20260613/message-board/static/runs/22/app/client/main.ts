import type { Message } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * In development, Vite proxies /api requests to the backend (see vite.config.ts).
 * In production, requests go to the same origin that serves the static files.
 * We fall back to an absolute URL only when explicitly configured.
 */
const API_BASE = "/api";

// ---------------------------------------------------------------------------
// DOM References
// ---------------------------------------------------------------------------

const messageList = document.getElementById("message-list") as HTMLUListElement;
const messageForm = document.getElementById("message-form") as HTMLFormElement;
const messageInput = document.getElementById("message-input") as HTMLInputElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/**
 * Formats an ISO timestamp into a human-friendly local time string.
 */
function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString();
}

/**
 * Creates a DOM element for a single message.
 */
function createMessageElement(message: Message): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "message";
  li.dataset.id = String(message.id);

  const textSpan = document.createElement("span");
  textSpan.className = "message-text";
  textSpan.textContent = message.text;

  const metaSpan = document.createElement("span");
  metaSpan.className = "message-meta";
  metaSpan.textContent = `#${message.id} · ${formatTime(message.created_at)}`;

  li.appendChild(textSpan);
  li.appendChild(metaSpan);
  return li;
}

/**
 * Appends a message to the list and scrolls to the bottom.
 */
function appendMessage(message: Message): void {
  const el = createMessageElement(message);
  messageList.appendChild(el);
  el.scrollIntoView({ behavior: "smooth" });
}

/** Set of message IDs already rendered, to avoid duplicates */
const renderedIds = new Set<number>();

/**
 * Appends a message only if it hasn't been rendered yet.
 */
function appendMessageIfNew(message: Message): void {
  if (renderedIds.has(message.id)) return;
  renderedIds.add(message.id);
  appendMessage(message);
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/**
 * Fetches all historical messages from the server.
 */
async function fetchMessages(): Promise<Message[]> {
  const res = await fetch(`${API_BASE}/messages`);
  if (!res.ok) {
    throw new Error(`Failed to fetch messages: ${res.status}`);
  }
  return (await res.json()) as Message[];
}

/**
 * Posts a new message to the server.
 */
async function postMessage(text: string): Promise<Message> {
  const res = await fetch(`${API_BASE}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as Message;
}

// ---------------------------------------------------------------------------
// SSE Connection
// ---------------------------------------------------------------------------

function setStatus(connected: boolean): void {
  statusEl.textContent = connected ? "Connected" : "Reconnecting…";
  statusEl.className = `status ${connected ? "connected" : "disconnected"}`;
}

/**
 * Opens an EventSource to /api/stream and listens for new-message events.
 * The browser-native EventSource automatically reconnects on failure.
 */
function connectSSE(): void {
  const source = new EventSource(`${API_BASE}/stream`);

  source.addEventListener("connected", () => {
    setStatus(true);
  });

  source.addEventListener("new-message", (event: MessageEvent) => {
    const message = JSON.parse(event.data) as Message;
    appendMessageIfNew(message);
  });

  source.addEventListener("error", () => {
    setStatus(false);
    // EventSource will auto-reconnect; no manual logic needed.
  });
}

// ---------------------------------------------------------------------------
// Form handling
// ---------------------------------------------------------------------------

messageForm.addEventListener("submit", async (e: Event) => {
  e.preventDefault();

  const text = messageInput.value.trim();
  if (!text) return;

  const submitButton = messageForm.querySelector("button") as HTMLButtonElement;
  submitButton.disabled = true;
  messageInput.disabled = true;

  try {
    await postMessage(text);
    messageInput.value = "";
  } catch (err) {
    console.error("Failed to send message:", err);
    alert(`Failed to send message: ${(err as Error).message}`);
  } finally {
    submitButton.disabled = false;
    messageInput.disabled = false;
    messageInput.focus();
  }
});

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  try {
    const messages = await fetchMessages();
    for (const msg of messages) {
      appendMessageIfNew(msg);
    }
  } catch (err) {
    console.error("Failed to load initial messages:", err);
  }

  connectSSE();
}

init();
