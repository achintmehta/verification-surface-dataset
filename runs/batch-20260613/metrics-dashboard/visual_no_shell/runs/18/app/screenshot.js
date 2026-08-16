const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://localhost:3000');
  await page.waitForSelector('#theme-toggle');
  await page.click('#theme-toggle');
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: 'dark_mode.png' });
  
  await page.setViewport({ width: 360, height: 800 });
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: 'mobile.png' });
  
  await page.setViewport({ width: 768, height: 800 });
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: 'tablet.png' });
  
  await browser.close();
})();
