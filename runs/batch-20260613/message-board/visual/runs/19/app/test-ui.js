import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  
  // Wait for messages to load
  await page.waitForSelector('.message');
  
  // Post a new message
  await page.fill('#message-input', 'Test message from Playwright');
  await page.click('button[type="submit"]');
  
  // Wait for the new message to appear
  await page.waitForFunction(() => {
    const messages = document.querySelectorAll('.message-text');
    return Array.from(messages).some(m => m.textContent === 'Test message from Playwright');
  });
  
  console.log('Test passed!');
  await browser.close();
})();
