import type { Message } from "./api.js";

const STREAM_URL = "/api/stream";

export type MessageHandler = (message: Message) => void;

/**
 * Opens a Server-Sent Events connection to the backend and invokes `onMessage`
 * every time a `newMessage` event is received.
 *
 * Returns a cleanup function that closes the connection.
 */
export function connectSSE(onMessage: MessageHandler): () => void {
  const source = new EventSource(STREAM_URL);

  source.addEventListener("newMessage", (event: MessageEvent) => {
    const message: Message = JSON.parse(event.data as string);
    onMessage(message);
  });

  source.addEventListener("error", () => {
    // EventSource will automatically attempt to reconnect.
    console.warn("SSE connection error – will retry automatically");
  });

  return () => {
    source.close();
  };
}
