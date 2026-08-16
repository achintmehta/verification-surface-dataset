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
  
  console.log('Adding Card 3...');
  await page1.evaluate(async () => {
    await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: 1, text: 'Card 3' })
    });
  });
  
  await new Promise(r => setTimeout(r, 500));
  
  let cards2 = await page2.$$eval('.column:nth-child(1) .card', els => els.map(el => el.textContent));
  console.log('Page 2 Column 1 Cards:', cards2);
  
  console.log('Moving Card 3 before Card 1...');
  const card3Id = await page1.$eval('.column:nth-child(1) .card:last-child', el => el.dataset.id);
  const card1Id = await page1.$eval('.column:nth-child(1) .card:first-child', el => el.dataset.id);
  
  await page1.evaluate(async (id, beforeId) => {
    await fetch(`/api/cards/${id}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: 1, beforeId, afterId: null })
    });
  }, card3Id, card1Id);
  
  await new Promise(r => setTimeout(r, 500));
  
  cards2 = await page2.$$eval('.column:nth-child(1) .card', els => els.map(el => el.textContent));
  console.log('Page 2 Column 1 Cards after move:', cards2);
  
  await browser.close();
})();
