import type {
  SSECardCreatedEvent,
  SSECardMovedEvent,
  SSEColumnRenormalizedEvent,
} from '../../shared/types.js';
import { addCard, moveCardInState, updateColumnCards } from './state.js';

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

type StatusCallback = (connected: boolean) => void;
let onStatusChange: StatusCallback | null = null;

export function setStatusCallback(cb: StatusCallback): void {
  onStatusChange = cb;
}

function setConnected(connected: boolean): void {
  if (onStatusChange) onStatusChange(connected);
}

export function connectSSE(): void {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource('/api/stream');

  eventSource.addEventListener('connected', () => {
    setConnected(true);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  });

  eventSource.addEventListener('card_created', (e: MessageEvent) => {
    const data = JSON.parse(e.data) as SSECardCreatedEvent;
    addCard(data.card);
  });

  eventSource.addEventListener('card_moved', (e: MessageEvent) => {
    const data = JSON.parse(e.data) as SSECardMovedEvent;
    moveCardInState(data.card, data.previousColumnId);
  });

  eventSource.addEventListener('column_renormalized', (e: MessageEvent) => {
    const data = JSON.parse(e.data) as SSEColumnRenormalizedEvent;
    updateColumnCards(data.columnId, data.cards);
  });

  eventSource.onerror = () => {
    setConnected(false);
    eventSource?.close();
    eventSource = null;

    // Reconnect after a delay
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectSSE();
      }, 2000);
    }
  };
}

export function disconnectSSE(): void {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  setConnected(false);
}
