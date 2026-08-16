const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('http://localhost:3000');
  
  // 1280px
  await page.setViewport({ width: 1280, height: 800 });
  await page.screenshot({ path: 'screenshot_1280.png' });
  
  // 768px
  await page.setViewport({ width: 768, height: 800 });
  await page.screenshot({ path: 'screenshot_768.png' });
  
  // 360px
  await page.setViewport({ width: 360, height: 800 });
  await page.screenshot({ path: 'screenshot_360.png' });
  
  // Dark mode
  await page.click('#theme-toggle');
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: 'screenshot_360_dark.png' });
  
  await browser.close();
})();
