const fs = require('fs');
let code = fs.readFileSync('src/main.js', 'utf8');

const newApplyMutation = `
function applyMutation(message) {
  if (message.type === 'create_label') {
    allLabels.push(message.label);
    allLabels.sort((a, b) => a.name.localeCompare(b.name));
    render();
    return;
  }
  if (message.type === 'update_label') {
    const index = allLabels.findIndex(l => l.id === message.label.id);
    if (index !== -1) {
      allLabels[index] = message.label;
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
      // Update labels on cards
      for (const column of board.columns) {
        for (const card of column.cards) {
          if (card.labels) {
            const lIndex = card.labels.findIndex(l => l.id === message.label.id);
            if (lIndex !== -1) {
              card.labels[lIndex] = message.label;
            }
          }
        }
      }
      render();
    }
    return;
  }
  if (message.type === 'delete_label') {
    allLabels = allLabels.filter(l => l.id !== message.labelId);
    selectedLabels.delete(message.labelId);
    for (const column of board.columns) {
      for (const card of column.cards) {
        if (card.labels) {
          card.labels = card.labels.filter(l => l.id !== message.labelId);
        }
      }
    }
    render();
    return;
  }
  if (message.type === 'assign_label') {
    const cardInfo = findCard(message.cardId);
    if (cardInfo) {
      const label = allLabels.find(l => l.id === message.labelId);
      if (label) {
        cardInfo.card.labels = cardInfo.card.labels || [];
        if (!cardInfo.card.labels.some(l => l.id === message.labelId)) {
          cardInfo.card.labels.push(label);
          render();
        }
      }
    }
    return;
  }
  if (message.type === 'unassign_label') {
    const cardInfo = findCard(message.cardId);
    if (cardInfo && cardInfo.card.labels) {
      cardInfo.card.labels = cardInfo.card.labels.filter(l => l.id !== message.labelId);
      render();
    }
    return;
  }

  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (!message.card) return;
  const card = message.card;
  removeCardEverywhere(card.id);
  const target = board.columns.find((column) => column.id === card.column_id || column.id === message.columnId);
  if (!target) return;
  target.cards.push(card);
  target.cards.sort(compareCards);
  render();
  setStatus('Synced');
}
`;

code = code.replace(
  /function applyMutation\(message\) \{[\s\S]*?setStatus\('Synced'\);\n\}/,
  newApplyMutation.trim()
);

fs.writeFileSync('src/main.js', code);
