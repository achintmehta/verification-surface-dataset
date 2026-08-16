const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  await page.setViewport({ width: 360, height: 800 });
  await page.goto('http://localhost:5173');
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: 'screenshot_360.png' });

  await page.setViewport({ width: 768, height: 1024 });
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: 'screenshot_768.png' });

  await browser.close();
})();