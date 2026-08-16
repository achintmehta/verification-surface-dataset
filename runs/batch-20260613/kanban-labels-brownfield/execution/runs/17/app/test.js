import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('http://localhost:5173');
  await page.waitForSelector('.card');
  const html = await page.content();
  console.log(html.includes('Fix bug'));
  console.log(html.includes('Bug'));
  await browser.close();
})();
