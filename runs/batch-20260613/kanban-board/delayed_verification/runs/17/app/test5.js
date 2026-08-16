import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page1 = await browser.newPage();
  
  console.log('Navigating...');
  await page1.goto('http://localhost:5173');
  
  console.log('Waiting for columns...');
  await page1.waitForSelector('.column');
  
  console.log('Adding Card A, B, C...');
  await page1.evaluate(async () => {
    await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: 3, text: 'Card A' })
    });
    await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: 3, text: 'Card B' })
    });
    await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: 3, text: 'Card C' })
    });
  });
  
  await new Promise(r => setTimeout(r, 500));
  
  const cardAId = await page1.$eval('.column:nth-child(3) .card:nth-child(1)', el => el.dataset.id);
  const cardBId = await page1.$eval('.column:nth-child(3) .card:nth-child(2)', el => el.dataset.id);
  const cardCId = await page1.$eval('.column:nth-child(3) .card:nth-child(3)', el => el.dataset.id);
  
  console.log('Moving Card C between A and B many times to trigger renormalization...');
  
  for (let i = 0; i < 30; i++) {
    await page1.evaluate(async (id, beforeId, afterId) => {
      await fetch(`/api/cards/${id}/move`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columnId: 3, beforeId, afterId })
      });
    }, cardCId, cardBId, cardAId);
    
    // Wait a bit for the move to process
    await new Promise(r => setTimeout(r, 50));
  }
  
  await new Promise(r => setTimeout(r, 1000));
  
  const cards = await page1.$$eval('.column:nth-child(3) .card', els => els.map(el => ({
    text: el.textContent,
    pos: el.dataset.position
  })));
  
  console.log('Cards after many moves:', cards);
  
  await browser.close();
})();
