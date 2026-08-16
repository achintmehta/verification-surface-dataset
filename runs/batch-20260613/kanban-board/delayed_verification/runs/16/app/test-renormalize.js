import fetch from 'node-fetch';

async function run() {
  let cardA = 'card-1781325044966-246';
  let cardB = 'card-1781325045491-991';

  for (let i = 0; i < 25; i++) {
    // Move A before B
    let res = await fetch(`http://localhost:3000/api/cards/${cardA}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: 'col-3', beforeId: cardB })
    });
    let data = await res.json();
    console.log(`A moved to ${data.position}`);

    // Move B before A
    res = await fetch(`http://localhost:3000/api/cards/${cardB}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: 'col-3', beforeId: cardA })
    });
    data = await res.json();
    console.log(`B moved to ${data.position}`);
  }
}

run();
