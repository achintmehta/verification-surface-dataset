import fetch from 'node-fetch';

(async () => {
  // Create cards
  let res = await fetch('http://localhost:3000/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId: 3, text: 'Card A' })
  });
  const cardA = await res.json();
  
  res = await fetch('http://localhost:3000/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId: 3, text: 'Card B' })
  });
  const cardB = await res.json();
  
  res = await fetch('http://localhost:3000/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId: 3, text: 'Card C' })
  });
  const cardC = await res.json();
  
  console.log('Initial cards:', cardA.position, cardB.position, cardC.position);
  
  for (let i = 0; i < 30; i++) {
    const idToMove = i % 2 === 0 ? cardC.id : cardB.id;
    const beforeId = i % 2 === 0 ? cardB.id : cardC.id;
    
    res = await fetch(`http://localhost:3000/api/cards/${idToMove}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: 3, beforeId, afterId: cardA.id })
    });
    const updated = await res.json();
    console.log(`Iteration ${i}: moved ${idToMove} to ${updated.position}`);
  }
  
  res = await fetch('http://localhost:3000/api/board');
  const board = await res.json();
  console.log('Final cards in column 3:', board.find(c => c.id === 3).cards.map(c => c.position));
})();
