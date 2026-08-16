const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('http://localhost:3000');
  
  // Click on a day column to create an event
  await page.mouse.click(200, 200);
  await page.waitForSelector('#event-modal:not(.hidden)');
  
  await page.type('#event-title', 'Test Event 1');
  await page.click('#save-btn');
  
  await page.waitForSelector('.event-block');
  
  // Create another overlapping event
  await page.mouse.click(200, 220);
  await page.waitForSelector('#event-modal:not(.hidden)');
  
  await page.type('#event-title', 'Test Event 2');
  await page.click('#save-btn');
  
  await page.waitForTimeout(1000);
  
  await page.screenshot({ path: 'test_overlap.png' });
  await browser.close();
})();
