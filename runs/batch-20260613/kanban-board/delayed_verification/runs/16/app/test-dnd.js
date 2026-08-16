import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('http://localhost:5173');

  await page.waitForSelector('.column');

  // Add two cards to the first column
  const columns = await page.$$('.column');
  const firstColInput = await columns[0].$('input');
  
  await firstColInput.type('Card 1');
  await firstColInput.press('Enter');
  await new Promise(r => setTimeout(r, 500));

  const columnsAfter = await page.$$('.column');
  const firstColInputAfter = await columnsAfter[0].$('input');
  await firstColInputAfter.type('Card 2');
  await firstColInputAfter.press('Enter');
  await new Promise(r => setTimeout(r, 500));

  // Drag Card 2 to the second column
  const cards = await page.$$('.card');
  let card2;
  for (const c of cards) {
    const text = await page.evaluate(el => el.textContent, c);
    if (text === 'Card 2') {
      card2 = c;
      break;
    }
  }

  const columns2 = await page.$$('.column');
  const col2 = await columns2[1].$('.card-list');

  const card2Box = await card2.boundingBox();
  const col2Box = await col2.boundingBox();

  await page.mouse.move(card2Box.x + card2Box.width / 2, card2Box.y + card2Box.height / 2);
  await page.mouse.down();
  await page.mouse.move(col2Box.x + col2Box.width / 2, col2Box.y + 20, { steps: 10 });
  await page.mouse.up();

  await new Promise(r => setTimeout(r, 1000));

  // Check if Card 2 is in the second column
  const isCard2InCol2 = await page.evaluate(() => {
    const col2 = document.querySelectorAll('.column')[1];
    const cards = Array.from(col2.querySelectorAll('.card'));
    return cards.some(c => c.textContent === 'Card 2');
  });

  console.log(`Card 2 in Col 2: ${isCard2InCol2}`);

  await browser.close();
})();
