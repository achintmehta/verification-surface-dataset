import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('http://localhost:5173');

  // Wait for board to load
  await page.waitForSelector('.column');

  // Get columns
  const columns = await page.$$('.column');
  console.log(`Found ${columns.length} columns`);

  // Add a card to the first column
  const firstColInput = await columns[0].$('input');
  await firstColInput.type('Puppeteer Card');
  await firstColInput.press('Enter');

  // Wait for card to appear
  await page.waitForSelector('.card');
  const cards = await page.$$('.card');
  console.log(`Found ${cards.length} cards`);

  // Get card text
  const cardText = await page.evaluate(el => el.textContent, cards[0]);
  console.log(`Card text: ${cardText}`);

  await browser.close();
})();
