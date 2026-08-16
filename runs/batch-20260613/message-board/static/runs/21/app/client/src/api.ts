/** Shared type for a message coming from the API. */
export interface Message {
  id: number;
  text: string;
  created_at: string;
}

const API_BASE = "/api";

/**
 * Fetch the most recent messages from the server.
 */
export async function fetchMessages(): Promise<Message[]> {
  const res = await fetch(`${API_BASE}/messages`);
  if (!res.ok) {
    throw new Error(`Failed to fetch messages: ${res.status}`);
  }
  return res.json() as Promise<Message[]>;
}

/**
 * Post a new text message to the server.
 */
export async function postMessage(text: string): Promise<Message> {
  const res = await fetch(`${API_BASE}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`Failed to post message: ${res.status}`);
  }
  return res.json() as Promise<Message>;
}
