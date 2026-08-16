import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('http://localhost:5173');
  
  // Wait for board to load
  await page.waitForSelector('.column');
  
  // Add a card
  await page.click('.column:nth-child(1) .add-card');
  await page.type('.column:nth-child(1) .add-card-form textarea', 'Card 1');
  await page.click('.column:nth-child(1) .add-card-form button');
  
  await page.waitForSelector('.card');
  
  const cards = await page.$$eval('.card', els => els.map(el => el.textContent));
  console.log('Cards:', cards);
  
  await browser.close();
})();
