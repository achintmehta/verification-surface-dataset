/**
 * Client-side board state store.
 *
 * Columns are stored in order. Each column has a `cards` array sorted by position.
 * All mutations return a new state object (immutable-style) so the renderer can
 * diff and update the DOM efficiently.
 */

export function createStore(initialBoard) {
  // columns: Array<{ id, title, position, cards: Array<card> }>
  let columns = initialBoard.columns.map((col) => ({
    ...col,
    cards: [...(col.cards ?? [])].sort((a, b) => a.position - b.position),
  }));

  function getColumns() {
    return columns;
  }

  function getColumn(columnId) {
    return columns.find((c) => c.id === columnId) ?? null;
  }

  function getCard(cardId) {
    for (const col of columns) {
      const card = col.cards.find((c) => c.id === cardId);
      if (card) return { card, column: col };
    }
    return null;
  }

  /** Replace or insert a card, ensuring it lives in exactly one column. */
  function upsertCard(newCard) {
    // Remove from any column it currently lives in
    columns = columns.map((col) => ({
      ...col,
      cards: col.cards.filter((c) => c.id !== newCard.id),
    }));

    // Insert into the target column, sorted by position
    columns = columns.map((col) => {
      if (col.id !== newCard.column_id) return col;
      const cards = [...col.cards, newCard].sort((a, b) => a.position - b.position);
      return { ...col, cards };
    });
  }

  /** Replace the entire card list for a column (used after renormalization). */
  function replaceColumnCards(columnId, cards) {
    columns = columns.map((col) => {
      if (col.id !== columnId) return col;
      return {
        ...col,
        cards: [...cards].sort((a, b) => a.position - b.position),
      };
    });
  }

  /**
   * Optimistically move a card within the local state.
   * Inserts the card between beforeCard and afterCard in the target column.
   * Returns the card with a synthetic position so the UI can render immediately.
   */
  function optimisticMove(cardId, targetColumnId, beforeId, afterId) {
    const found = getCard(cardId);
    if (!found) return null;

    const { card } = found;
    const targetCol = getColumn(targetColumnId);
    if (!targetCol) return null;

    // Compute synthetic position
    const beforeCard = beforeId ? targetCol.cards.find((c) => c.id === beforeId) : null;
    const afterCard  = afterId  ? targetCol.cards.find((c) => c.id === afterId)  : null;

    let syntheticPos;
    if (!beforeCard && !afterCard) {
      syntheticPos = 1000;
    } else if (!beforeCard) {
      syntheticPos = afterCard.position / 2;
    } else if (!afterCard) {
      syntheticPos = beforeCard.position + 1000;
    } else {
      syntheticPos = (beforeCard.position + afterCard.position) / 2;
    }

    const optimisticCard = { ...card, column_id: targetColumnId, position: syntheticPos };
    upsertCard(optimisticCard);
    return optimisticCard;
  }

  return {
    getColumns,
    getColumn,
    getCard,
    upsertCard,
    replaceColumnCards,
    optimisticMove,
  };
}
