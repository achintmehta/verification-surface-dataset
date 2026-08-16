/** Shared types for the Kanban board application */

export interface Column {
  id: string;
  title: string;
  position: number;
  cards: Card[];
}

export interface Card {
  id: string;
  column_id: string;
  text: string;
  position: number;
  created_at: string;
}

export interface Board {
  columns: Column[];
}

/** Request to create a new card */
export interface CreateCardRequest {
  column_id: string;
  text: string;
}

/** Request to move a card */
export interface MoveCardRequest {
  columnId: string;
  afterId: string | null;
  beforeId: string | null;
}

/** SSE event types */
export type SSEEventType = 'card_created' | 'card_moved' | 'column_renormalized' | 'board_sync';

export interface SSECardCreatedEvent {
  type: 'card_created';
  card: Card;
}

export interface SSECardMovedEvent {
  type: 'card_moved';
  card: Card;
  previousColumnId: string;
}

export interface SSEColumnRenormalizedEvent {
  type: 'column_renormalized';
  columnId: string;
  cards: Card[];
}

export interface SSEBoardSyncEvent {
  type: 'board_sync';
  board: Board;
}

export type SSEEvent =
  | SSECardCreatedEvent
  | SSECardMovedEvent
  | SSEColumnRenormalizedEvent
  | SSEBoardSyncEvent;
