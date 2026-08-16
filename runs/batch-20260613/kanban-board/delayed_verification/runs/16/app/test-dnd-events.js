import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('http://localhost:5173');

  await page.waitForSelector('.column');

  // Add a card
  const columns = await page.$$('.column');
  const firstColInput = await columns[0].$('input');
  await firstColInput.type('Drag Me');
  await firstColInput.press('Enter');
  await new Promise(r => setTimeout(r, 500));

  // Dispatch drag and drop events
  await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll('.card')).find(c => c.textContent === 'Drag Me');
    const col2 = document.querySelectorAll('.column')[1].querySelector('.card-list');

    const dataTransfer = new DataTransfer();
    
    const dragStartEvent = new DragEvent('dragstart', { dataTransfer, bubbles: true });
    card.dispatchEvent(dragStartEvent);

    const dragOverEvent = new DragEvent('dragover', { dataTransfer, bubbles: true, clientY: 100 });
    col2.dispatchEvent(dragOverEvent);

    const dropEvent = new DragEvent('drop', { dataTransfer, bubbles: true });
    col2.dispatchEvent(dropEvent);

    const dragEndEvent = new DragEvent('dragend', { dataTransfer, bubbles: true });
    card.dispatchEvent(dragEndEvent);
  });

  await new Promise(r => setTimeout(r, 1000));

  const isCardInCol2 = await page.evaluate(() => {
    const col2 = document.querySelectorAll('.column')[1];
    const cards = Array.from(col2.querySelectorAll('.card'));
    return cards.some(c => c.textContent === 'Drag Me');
  });

  console.log(`Card in Col 2: ${isCardInCol2}`);

  await browser.close();
})();
