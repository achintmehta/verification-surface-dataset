import type { Board, Card, Column } from '../../shared/types.js';

/**
 * Client-side state management for the Kanban board.
 * Maintains the authoritative board state and provides mutation methods.
 */

export interface BoardState {
  columns: Column[];
}

let state: BoardState = { columns: [] };

const listeners: Array<() => void> = [];

export function getState(): BoardState {
  return state;
}

export function subscribe(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function setBoardState(board: Board): void {
  state = {
    columns: board.columns.map((col) => ({
      ...col,
      cards: [...col.cards].sort((a, b) => a.position - b.position),
    })),
  };
  notify();
}

export function addCard(card: Card): void {
  const column = state.columns.find((c) => c.id === card.column_id);
  if (!column) return;

  // Avoid duplicates
  const existing = column.cards.findIndex((c) => c.id === card.id);
  if (existing >= 0) {
    column.cards[existing] = card;
  } else {
    column.cards.push(card);
  }
  column.cards.sort((a, b) => a.position - b.position);
  notify();
}

export function moveCardInState(card: Card, previousColumnId: string): void {
  // Remove from all columns (ensure it only exists in one place)
  for (const col of state.columns) {
    col.cards = col.cards.filter((c) => c.id !== card.id);
  }

  // Add to the target column
  const targetColumn = state.columns.find((c) => c.id === card.column_id);
  if (!targetColumn) return;

  targetColumn.cards.push(card);
  targetColumn.cards.sort((a, b) => a.position - b.position);
  notify();
}

export function updateColumnCards(columnId: string, cards: Card[]): void {
  const column = state.columns.find((c) => c.id === columnId);
  if (!column) return;

  column.cards = [...cards].sort((a, b) => a.position - b.position);
  notify();
}

/**
 * Optimistically move a card in the DOM state.
 * Returns the afterId and beforeId for the server request.
 */
export function optimisticMove(
  cardId: string,
  targetColumnId: string,
  targetIndex: number
): { afterId: string | null; beforeId: string | null } {
  // Find and remove the card from its current column
  let card: Card | null = null;
  for (const col of state.columns) {
    const idx = col.cards.findIndex((c) => c.id === cardId);
    if (idx >= 0) {
      card = col.cards.splice(idx, 1)[0];
      break;
    }
  }
  if (!card) return { afterId: null, beforeId: null };

  // Find the target column
  const targetColumn = state.columns.find((c) => c.id === targetColumnId);
  if (!targetColumn) return { afterId: null, beforeId: null };

  // Insert at the target index
  const clampedIndex = Math.min(targetIndex, targetColumn.cards.length);
  card.column_id = targetColumnId;
  targetColumn.cards.splice(clampedIndex, 0, card);

  // Determine afterId and beforeId
  const afterId = clampedIndex > 0 ? targetColumn.cards[clampedIndex - 1].id : null;
  const beforeId = clampedIndex < targetColumn.cards.length - 1 ? targetColumn.cards[clampedIndex + 1].id : null;

  notify();

  return { afterId, beforeId };
}
