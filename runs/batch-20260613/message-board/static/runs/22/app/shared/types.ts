/**
 * Represents a message stored in the database and transmitted over the wire.
 */
export interface Message {
  /** Unique auto-incrementing identifier */
  id: number;
  /** The text content of the message */
  text: string;
  /** ISO-8601 timestamp of when the message was created */
  created_at: string;
}

/**
 * Payload sent by the client when creating a new message.
 */
export interface CreateMessageRequest {
  text: string;
}

/**
 * SSE event types the server can push to connected clients.
 */
export type SSEEventType = "new-message" | "connected";

/**
 * Shape of an SSE event carrying a new message.
 */
export interface SSENewMessageEvent {
  type: "new-message";
  data: Message;
}

/**
 * Shape of the initial SSE connection acknowledgement.
 */
export interface SSEConnectedEvent {
  type: "connected";
  data: { clientId: string };
}
