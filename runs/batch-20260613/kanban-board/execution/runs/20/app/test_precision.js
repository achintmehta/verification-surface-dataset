async function run() {
  let lastId = 3;
  for (let i = 0; i < 60; i++) {
    const res = await fetch('http://localhost:3000/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: 1, text: 'Card ' + i })
    });
    const card = await res.json();
    
    const moveRes = await fetch('http://localhost:3000/api/cards/' + card.id + '/move', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: 1, beforeId: 2, afterId: lastId })
    });
    const movedCard = await moveRes.json();
    console.log(i, movedCard.position);
    lastId = card.id;
  }
}

run();
