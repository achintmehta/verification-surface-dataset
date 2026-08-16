import fetch from 'node-fetch';

async function run() {
  // Create two cards
  let res = await fetch('http://localhost:3000/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId: 'col-2', text: 'Card X' })
  });
  let cardX = await res.json();

  res = await fetch('http://localhost:3000/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId: 'col-2', text: 'Card Y' })
  });
  let cardY = await res.json();

  // Create two more cards to move
  res = await fetch('http://localhost:3000/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId: 'col-2', text: 'Card 1' })
  });
  let card1 = await res.json();

  res = await fetch('http://localhost:3000/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId: 'col-2', text: 'Card 2' })
  });
  let card2 = await res.json();

  // Move Card 1 and Card 2 between X and Y concurrently
  const p1 = fetch(`http://localhost:3000/api/cards/${card1.id}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId: 'col-2', beforeId: cardY.id, afterId: cardX.id })
  });

  const p2 = fetch(`http://localhost:3000/api/cards/${card2.id}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId: 'col-2', beforeId: cardY.id, afterId: cardX.id })
  });

  await Promise.all([p1, p2]);

  // Check board state
  res = await fetch('http://localhost:3000/api/board');
  const board = await res.json();
  const col2 = board.find(c => c.id === 'col-2');
  console.log(col2.cards.map(c => `${c.text}: ${c.position}`));
}

run();
