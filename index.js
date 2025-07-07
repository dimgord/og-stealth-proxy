import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import Redis from 'ioredis';

puppeteer.use(StealthPlugin());

const redis = new Redis();
const app = express();

let browser;
let consecutiveFailures = 0;
const MAX_FAILURES = 5;

app.get('/', (_, res) => {
  res.send('👋 Stealth Puppeteer OG Proxy is running!');
});

app.get('/og-proxy', async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: 'Invalid or missing URL' });
  }

  try {
    const cached = await redis.get(url);
    if (cached) {
      console.log('[StealthProxy] Cache hit for', url);
      return res.json(JSON.parse(cached));
    }

    console.log('[StealthProxy] Navigating to', url);
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setViewport({ width: 1366, height: 768 });

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    try {
      //await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await page.goto(url, { timeout: 30000 });
      consecutiveFailures = 0;
    } catch (err) {
      console.error('[StealthProxy] Error during page.goto:', err.message);
      consecutiveFailures++;

      if (
        err.message.includes('Navigation timeout') ||
        err.message.includes('Protocol error')
      ) {
        if (consecutiveFailures >= MAX_FAILURES) {
          console.error('[StealthProxy] Too many consecutive failures — exiting...');
          process.exit(1);
        }
      } else {
        console.warn('[StealthProxy] Unknown error, not counting toward restart');
      }

      return res.status(500).json({ error: 'Page navigation error', message: err.message });
    }

    if (page.isClosed()) {
      return res.status(500).json({ error: 'Page closed unexpectedly' });
    }

    console.log('[StealthProxy] Final URL:', page.url());

    const metadata = await page.evaluate(() => {
      const getMeta = (prop) =>
        document.querySelector(`meta[property='og:${prop}']`)?.content ||
        document.querySelector(`meta[name='og:${prop}']`)?.content || '';
      return {
        title: getMeta('title') || document.title || '',
        description: getMeta('description') || '',
        image: getMeta('image') || '',
        url: getMeta('url') || location.href || '',
      };
    });

    await page.close();

    const md = JSON.stringify(metadata);
    const image = metadata.image;
    console.log('[StealthProxy] metadata: ', md);
    console.log('[StealthProxy] image: ', image);

    if (!metadata.title && !metadata.description && !metadata.image) {
      console.warn('[StealthProxy] Metadata appears empty — skipping cache');
      return res.status(500).json({ error: 'Empty metadata — possibly bot protection' });
    }

    if (image && image.trim() !== '') {
      await redis.set(url, md, 'EX', 60 * 60 * 10);
      console.log('[StealthProxy] Cached result for', url);
    } else {
      console.log('[StealthProxy] Not cached due to empty image');
    }

    res.json(metadata);
  } catch (err) {
    console.error('[StealthProxy] Error:', err.message);
    res.status(500).json({ error: 'Puppeteer error', message: err.message });
  }
});

const port = process.env.PORT || 3000;
(async () => {
  console.log('[StealthProxy] Launching persistent browser...');
  browser = await puppeteer.launch({
    headless: true,
    executablePath: '/usr/bin/google-chrome-stable',
    userDataDir: '/home/dimgord/.puppeteer_data',
    args: [
      '--headless',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--disable-crash-reporter',
      '--no-zygote',
    ],
    protocolTimeout: 60000,
  });

  app.listen(port, () => {
    console.log(`[StealthProxy] Listening on port ${port}`);
  });
})();

process.on('exit', () => browser?.close());
process.on('SIGINT', () => process.exit());
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

