import puppeteer from 'puppeteer';

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  console.log('Opening new page...');
  const page = await browser.newPage();

  console.log('Navigating...');
  await page.goto('https://www.facebook.com/share/p/1C3w5KvwGu/', { timeout: 30000 });

  const title = await page.title();
  console.log('Title:', title);

  await browser.close();
})();

