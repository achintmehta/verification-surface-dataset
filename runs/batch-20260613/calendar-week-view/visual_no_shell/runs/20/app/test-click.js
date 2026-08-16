const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  await page.goto('http://localhost:3000');
  
  // Scroll down
  await page.evaluate(() => {
    document.getElementById('days-grid').scrollTop = 500;
  });
  
  // Click on the first day column at y=600 (which should be 10:00)
  // The day column is inside days-grid.
  // The days-grid is at some offset.
  const rect = await page.evaluate(() => {
    const el = document.querySelector('.day-column');
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left };
  });
  
  await page.mouse.click(rect.left + 10, rect.top + 600);
  
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: 'screenshot_click.png' });
  
  await browser.close();
})();