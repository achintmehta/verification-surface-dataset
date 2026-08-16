import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('http://localhost:5173');

  await page.waitForSelector('.column');

  // Add two cards to the third column
  const columns = await page.$$('.column');
  const thirdColInput = await columns[2].$('input');
  
  await thirdColInput.type('Card A');
  await thirdColInput.press('Enter');
  await new Promise(r => setTimeout(r, 500));

  const columnsAfter = await page.$$('.column');
  const thirdColInputAfter = await columnsAfter[2].$('input');
  await thirdColInputAfter.type('Card B');
  await thirdColInputAfter.press('Enter');
  await new Promise(r => setTimeout(r, 500));

  // Dispatch drag and drop events to move Card B before Card A
  await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.column')[2].querySelectorAll('.card'));
    const cardA = cards.find(c => c.textContent === 'Card A');
    const cardB = cards.find(c => c.textContent === 'Card B');
    const col3 = document.querySelectorAll('.column')[2].querySelector('.card-list');

    const dataTransfer = new DataTransfer();
    
    const dragStartEvent = new DragEvent('dragstart', { dataTransfer, bubbles: true });
    cardB.dispatchEvent(dragStartEvent);

    // Simulate dragover above Card A
    const rect = cardA.getBoundingClientRect();
    const dragOverEvent = new DragEvent('dragover', { dataTransfer, bubbles: true, clientY: rect.top - 10 });
    col3.dispatchEvent(dragOverEvent);

    const dropEvent = new DragEvent('drop', { dataTransfer, bubbles: true });
    col3.dispatchEvent(dropEvent);

    const dragEndEvent = new DragEvent('dragend', { dataTransfer, bubbles: true });
    cardB.dispatchEvent(dragEndEvent);
  });

  await new Promise(r => setTimeout(r, 1000));

  const order = await page.evaluate(() => {
    const col3 = document.querySelectorAll('.column')[2];
    const cards = Array.from(col3.querySelectorAll('.card'));
    return cards.map(c => c.textContent);
  });

  console.log(`Order in Col 3: ${order.join(', ')}`);

  await browser.close();
})();
