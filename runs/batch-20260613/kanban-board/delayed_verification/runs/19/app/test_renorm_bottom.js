async function run() {
  let moveId = '117cb19c-da1a-4f27-8a4a-2e89c367f888'; // Card 1
  let beforeId = 'ae5a533d-d9df-4145-9c86-6ce5e4209b8e'; // Card 2 (at 3000)
  
  for (let i = 0; i < 20; i++) {
    const res = await fetch('http://localhost:3000/api/cards/' + moveId + '/move', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        columnId: 'a1d16ee4-64da-4219-8589-05a6bc24d53e',
        beforeId,
        afterId: null
      })
    });
    const data = await res.json();
    console.log(data.position);
    
    beforeId = moveId;
    moveId = (moveId === '117cb19c-da1a-4f27-8a4a-2e89c367f888') ? 'ae5a533d-d9df-4145-9c86-6ce5e4209b8e' : '117cb19c-da1a-4f27-8a4a-2e89c367f888';
  }
}
run();
