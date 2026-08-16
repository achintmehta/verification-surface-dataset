async function run() {
  let moveId = '2fbf5a56-0065-48d8-ab49-22d7d8f31f67'; // Card 3
  let afterId = '117cb19c-da1a-4f27-8a4a-2e89c367f888'; // Card 1
  
  for (let i = 0; i < 20; i++) {
    const res = await fetch('http://localhost:3000/api/cards/' + moveId + '/move', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        columnId: 'a1d16ee4-64da-4219-8589-05a6bc24d53e',
        beforeId: null,
        afterId
      })
    });
    const data = await res.json();
    console.log(data.position);
    
    afterId = moveId;
    moveId = (moveId === '2fbf5a56-0065-48d8-ab49-22d7d8f31f67') ? '117cb19c-da1a-4f27-8a4a-2e89c367f888' : '2fbf5a56-0065-48d8-ab49-22d7d8f31f67';
  }
}
run();
