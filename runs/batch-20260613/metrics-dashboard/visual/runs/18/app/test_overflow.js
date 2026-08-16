const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  for (const width of [360, 768, 1280]) {
    await page.setViewport({ width, height: 800 });
    await page.goto('http://localhost:5173');
    await new Promise(r => setTimeout(r, 1000));
    
    const hasOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    console.log(`Width ${width}: hasOverflow = ${hasOverflow}`);
  }

  await browser.close();
})();