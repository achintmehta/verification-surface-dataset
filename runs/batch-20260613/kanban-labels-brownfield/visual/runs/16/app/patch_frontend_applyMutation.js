import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

const applyMutationReplacement = `function applyMutation(message) {
  if (message.type === 'create_label') {
    labels.push(message.label);
    labels.sort((a, b) => a.name.localeCompare(b.name));
    render();
    return;
  }
  if (message.type === 'update_label') {
    const index = labels.findIndex(l => l.id === message.label.id);
    if (index !== -1) {
      labels[index] = message.label;
      labels.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (message.board) board = normalizeBoard(message.board);
    render();
    return;
  }
  if (message.type === 'delete_label') {
    labels = labels.filter(l => l.id !== message.labelId);
    selectedLabelIds.delete(message.labelId);
    if (message.board) board = normalizeBoard(message.board);
    render();
    return;
  }
  if (message.type === 'assign_label' || message.type === 'unassign_label') {
    if (message.board) board = normalizeBoard(message.board);
    render();
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
}`;

code = code.replace(/function applyMutation\(message\) \{[\s\S]*?setStatus\('Synced'\);\n\}/m, applyMutationReplacement);
fs.writeFileSync('src/main.js', code);
