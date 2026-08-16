import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page1 = await browser.newPage();
  const page2 = await browser.newPage();
  
  console.log('Navigating...');
  await page1.goto('http://localhost:5173');
  await page2.goto('http://localhost:5173');
  
  console.log('Waiting for columns...');
  await page1.waitForSelector('.column');
  await page2.waitForSelector('.column');
  
  console.log('Adding Card 1...');
  await page1.evaluate(async () => {
    await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: 1, text: 'Card 1' })
    });
  });
  
  console.log('Waiting for Card 1...');
  await page1.waitForSelector('.card');
  await page2.waitForSelector('.card');
  
  let cards2 = await page2.$$eval('.card', els => els.map(el => el.textContent));
  console.log('Page 2 Cards after add:', cards2);
  
  console.log('Adding Card 2...');
  await page1.evaluate(async () => {
    await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: 1, text: 'Card 2' })
    });
  });
  
  console.log('Waiting for Card 2...');
  await new Promise(r => setTimeout(r, 500));
  
  cards2 = await page2.$$eval('.card', els => els.map(el => el.textContent));
  console.log('Page 2 Cards after second add:', cards2);
  
  console.log('Moving Card 2...');
  const card2Id = await page1.$eval('.card:nth-child(2)', el => el.dataset.id);
  await page1.evaluate(async (id) => {
    await fetch(`/api/cards/${id}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: 2, beforeId: null, afterId: null })
    });
  }, card2Id);
  
  console.log('Waiting for move...');
  await new Promise(r => setTimeout(r, 500));
  
  const col2Cards = await page2.$$eval('.column:nth-child(2) .card', els => els.map(el => el.textContent));
  console.log('Page 2 Column 2 Cards after move:', col2Cards);
  
  await browser.close();
})();
