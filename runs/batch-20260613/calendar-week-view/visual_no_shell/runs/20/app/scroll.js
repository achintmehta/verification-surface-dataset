const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  await page.goto('http://localhost:3000');
  await page.evaluate(() => {
    document.getElementById('days-grid').scrollTop = 1000;
  });
  await page.screenshot({ path: 'screenshot_scroll.png' });
  await browser.close();
})();